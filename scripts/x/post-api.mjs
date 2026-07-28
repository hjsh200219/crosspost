#!/usr/bin/env node
// X (Twitter) publisher — official API v2 POST /2/tweets, OAuth 1.0a (HMAC-SHA1) manual signing.
// Single-tweet teaser publish: hook line(s) + (optional) image + canonical link, all in one tweet.
// Trimmed to fit X's weighted 280-char limit (CJK counts as 2, a URL counts as a fixed 23) by
// cutting on sentence boundaries after reserving room for the trailing link.
// Body source priority: posts/<slug>.x.txt (X-specific hook, written at publish time) >
// posts/<slug>.threads.txt > the canonical file (trimmed if it overflows the budget).
// Image: --image PATH (explicit, fails loudly) or an auto-resolved sibling <slug>.png/.jpg/.jpeg/.webp
// next to the post file (best-effort). webp/heic/avif/tiff are auto-converted to png via sips before
// upload through v1.1 media/upload. Attaching media suppresses X's link-preview card.
// Ledger: ledgers/published-x.json under $CROSSPOST_HOME.
// Credentials: X_API_KEY/X_API_SECRET/X_ACCESS_TOKEN/X_ACCESS_SECRET in your .env.
// Usage: node post-api.mjs <file> [...] [--image PATH] [--skip-done] [--delay <sec>] [--max <N>]
//        | --preview <file> (print the teaser without publishing) | --edit <id> <file> | --delete <id>

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { loadEnv, dataPath } from '../lib/env.mjs';
import { canonicalLink, linkText } from '../lib/canonical-link.mjs';
import { resolveImage } from '../lib/post-image.mjs';

loadEnv();
const LEDGER = dataPath('ledgers/published-x.json');
const API = 'https://api.x.com/2/tweets';
const LIMIT = 280;        // X weighted character limit
const URL_WEIGHT = 23;    // fixed weight for a t.co-shortened link
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CK = process.env.X_API_KEY;
const CS = process.env.X_API_SECRET;
const AT = process.env.X_ACCESS_TOKEN;
const AS = process.env.X_ACCESS_SECRET;

// --- OAuth 1.0a (RFC3986 percent-encode, HMAC-SHA1) ---
const enc = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function authHeader(method, url) {
  const oauth = {
    oauth_consumer_key: CK,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: AT,
    oauth_version: '1.0',
  };
  // The v2 JSON body is not part of the signature — only the sorted oauth_* params are signed.
  const paramStr = Object.keys(oauth).sort().map((k) => `${enc(k)}=${enc(oauth[k])}`).join('&');
  const base = [method.toUpperCase(), enc(url), enc(paramStr)].join('&');
  const signingKey = `${enc(CS)}&${enc(AS)}`;
  oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(base).digest('base64');
  return 'OAuth ' + Object.keys(oauth).sort().map((k) => `${enc(k)}="${enc(oauth[k])}"`).join(', ');
}

// --- X weighted character count (twitter-text configV3) ---
// 규칙은 "CJK만 2"가 아니라 그 반대다: 기본 2이고, weight 1은 U+0000–U+10FF와
// General Punctuation 세 구간뿐이다. 이모지는 grapheme 단위로 2 — ZWJ·variation
// selector로 이어진 시퀀스도 통째로 2이지 코드포인트마다 2가 아니다.
// 예전 구현은 이모지·기호를 1로 세서 예산을 과소 계상했고, 그만큼 덜 잘라
// 실제 280을 넘긴 트윗이 나갔다(비프리미엄 계정에선 그대로 발행 실패).
// `\p{RGI_Emoji}`가 더 정확하지만 v 플래그는 Node 20+ 전용이고 구문 오류는 parse 시점에
// 스크립트 전체를 죽인다 — 배포물이라 Node 16+에서 도는 Extended_Pictographic을 쓴다.
const GRAPHEMES = new Intl.Segmenter('und', { granularity: 'grapheme' });
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const lightCp = (c) => c <= 0x10FF || (c >= 0x2000 && c <= 0x200D) ||
  (c >= 0x2010 && c <= 0x201F) || (c >= 0x2032 && c <= 0x2037);
function weight(text) {
  let w = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    if (PICTOGRAPHIC.test(segment)) { w += 2; continue; } // 이모지 시퀀스 전체가 2
    for (const ch of segment) w += lightCp(ch.codePointAt(0)) ? 1 : 2;
  }
  return w;
}

// --- Teaser body construction ---
// X publishes a **single teaser tweet**, not the full text or a thread: a hook line or two +
// (optional) image + the canonical link. Rationale: even though the API accepts long "note
// tweet" bodies now, the timeline still truncates at 280 with a "Show more" — so anything past
// that point is unread on the scroll, and a teaser that fits the visible window reads better.
// Without an image, X renders a link-preview card (the canonical page's twitter:card =
// summary_large_image) with title/summary/OG image. **Attaching media suppresses the card** —
// it's one or the other.

// X's real weighting counts a URL at a fixed t.co weight regardless of its actual length. If a
// link is embedded in the body text, plain weight() overcounts it and truncates a teaser that
// would actually have fit.
function xWeight(text) {
  const urls = text.match(/https?:\/\/\S+/g) || [];
  return weight(text.replace(/https?:\/\/\S+/g, '')) + urls.length * URL_WEIGHT;
}

// Trim to budget on a sentence boundary. If not even one sentence fits, hard-cut on a word
// boundary and append an ellipsis.
function trimToBudget(text, budget) {
  const t = text.trim();
  if (xWeight(t) <= budget) return { text: t, truncated: false };
  // Teaser는 훅(첫 문단)에서만 자른다. 첫 문장이 예산을 넘겨도 다음 문단으로 넘어가지
  // 않는다 — 훅을 통째로 버리고 뒷문단으로 시작하는 teaser가 되기 때문. 그 경우는
  // 아래 hard-cut이 첫 문장을 단어 경계에서 자른다.
  let buf = "";
  for (const sent of t.split(/\n\n+/)[0].split(/(?<=[.!?。！？…])\s+/)) {
    const cand = buf ? `${buf} ${sent}` : sent;
    if (xWeight(cand) > budget) break;
    buf = cand;
  }
  if (buf) return { text: buf, truncated: true };
  // Even the first sentence overflows the budget → hard-cut on a word boundary.
  const ELLIPSIS = "…";
  let cut = "";
  for (const word of t.split(/\s+/)) {
    const cand = cut ? `${cut} ${word}` : word;
    if (xWeight(cand) + weight(ELLIPSIS) > budget) break;
    cut = cand;
  }
  return { text: (cut || t.slice(0, 10)) + ELLIPSIS, truncated: true };
}

// Teaser = hook + canonical link (one tweet). Reserve the label + link's weight and a blank
// line ahead of trimming the body.
function buildTeaser(body, link) {
  const label = link ? `${linkText()}: ` : "";
  const trailer = link ? `${label}${link}` : "";
  const reserve = link ? weight(label) + URL_WEIGHT + 2 : 0; // label + URL + "\n\n"
  const { text, truncated } = trimToBudget(body, LIMIT - reserve);
  return { text: link ? `${text}\n\n${trailer}` : text, truncated };
}

function readBody(file) {
  const slug = path.basename(file).replace(/\.txt$/, '');
  const dir = path.dirname(file);
  const xVar = path.join(dir, `${slug}.x.txt`);
  const tVar = path.join(dir, `${slug}.threads.txt`);
  const src = existsSync(xVar) ? xVar : existsSync(tVar) ? tVar : file;
  if (src !== file) console.error(`  ↳ X: using variant body (${path.basename(src)})`);
  return readFileSync(src, 'utf8').trim();
}

// 손상된 장부는 빈 장부가 아니다 — 그대로 진행하면 --skip-done이 전량 재발행하고
// saveLedger()가 복구 가능한 파일을 새 행들로 덮어쓴다. fail-closed.
function loadLedger() {
  if (!existsSync(LEDGER)) return [];
  try {
    return JSON.parse(readFileSync(LEDGER, 'utf8'));
  } catch (error) {
    console.error(`cannot read X ledger: ${error.message}`);
    process.exit(1);
  }
}
function saveLedger(l) { writeFileSync(LEDGER, JSON.stringify(l, null, 2) + '\n'); }

// Classify a v2 error response (problem+json or legacy errors[]) into a human-readable message.
// The batch loop below regex-matches keywords in this message to decide whether to stop or skip.
function classify(status, json, text) {
  const detail = json?.detail || json?.title || json?.errors?.[0]?.message || (text || '').slice(0, 200);
  if (status === 402) return `Credits depleted (402) — check your X Pay-Per-Use balance/limit. ${detail}`;
  if (status === 429) return `Rate limited (429) — X API rate limit, retry after a delay. ${detail}`;
  if (status === 401 || status === 403) {
    if (/duplicate/i.test(detail)) return `Duplicate content (403) — identical text already posted. ${detail}`;
    return `Auth failed (${status}) — check X_API_KEY/X_API_SECRET/X_ACCESS_TOKEN/X_ACCESS_SECRET in your .env. ${detail}`;
  }
  return `X API ${status}: ${detail}`;
}

async function postTweet(text, replyToId, mediaIds) {
  const body = replyToId ? { text, reply: { in_reply_to_tweet_id: replyToId } } : { text };
  if (mediaIds && mediaIds.length) body.media = { media_ids: mediaIds };
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: authHeader('POST', API), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const rawText = await res.text();
  const json = (() => { try { return JSON.parse(rawText); } catch { return {}; } })();
  if (!res.ok) throw new Error(classify(res.status, json, rawText));
  return json.data.id; // { data: { id, text } }
}

// Remove ledger rows referencing this tweet. If we don't, stats.mjs keeps querying the deleted
// id and it shows up as a "(fetch failed)" ghost row — especially likely to pile up with --edit,
// which deletes and republishes.
function pruneLedger(id) {
  const ledger = loadLedger();
  const kept = ledger.filter((e) => e.rootId !== id && !(e.ids || []).includes(id));
  if (kept.length !== ledger.length) {
    saveLedger(kept);
    console.log(`  ↳ Ledger cleanup: removed ${ledger.length - kept.length} row(s) (${id})`);
  }
  return ledger.length - kept.length;
}

async function deleteTweet(id) {
  const url = `${API}/${id}`;
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: authHeader('DELETE', url) } });
  const rawText = await res.text();
  const json = (() => { try { return JSON.parse(rawText); } catch { return {}; } })();
  if (!res.ok) throw new Error(classify(res.status, json, rawText));
  pruneLedger(id);
  return json.data?.deleted;
}

// Upload an image to X and return its media_id. The v1.1 media/upload (multipart) signature
// only covers the oauth_* params, not the body, so the existing authHeader(method, url) can be
// reused as-is. webp/heic/etc. are converted to png via sips (X media compatibility). Single
// upload, 5MB or under.
const UPLOAD = 'https://upload.twitter.com/1.1/media/upload.json';
async function uploadMedia(imgPath) {
  let p = imgPath, tmp = null;
  if (/\.(webp|heic|avif|tiff?)$/i.test(imgPath)) {
    tmp = path.join(os.tmpdir(), `x-media-${crypto.randomBytes(6).toString('hex')}.png`);
    execFileSync('sips', ['-s', 'format', 'png', imgPath, '--out', tmp], { stdio: 'ignore' });
    p = tmp;
  }
  try {
    const fd = new FormData();
    fd.append('media', new Blob([readFileSync(p)]), 'image.png');
    const res = await fetch(UPLOAD, { method: 'POST', headers: { Authorization: authHeader('POST', UPLOAD) }, body: fd });
    const t = await res.text();
    const j = (() => { try { return JSON.parse(t); } catch { return {}; } })();
    if (!res.ok) throw new Error(`media upload ${res.status}: ${j.errors?.[0]?.message || (t || '').slice(0, 160)}`);
    return j.media_id_string;
  } finally {
    if (tmp) { try { unlinkSync(tmp); } catch {} }
  }
}

async function publish(file, imageOverride) {
  if (!CK || !CS || !AT || !AS) throw new Error('Missing X credentials — check X_API_KEY/X_API_SECRET/X_ACCESS_TOKEN/X_ACCESS_SECRET in your .env');
  const body = readBody(file);
  const link = canonicalLink(file); // canonical URL, or null
  const { text, truncated } = buildTeaser(body, link);

  // Image: explicit --image (fails loudly) or an auto-resolved sibling image file
  // (best-effort). Attaching media suppresses the link-preview card, so a post with
  // an image relies on the image for visual weight; one without relies on the card.
  const imgPath = imageOverride || resolveImage(file)?.imageAbs || null;
  let mediaIds = null;
  if (imgPath) {
    try {
      mediaIds = [await uploadMedia(imgPath)];
      console.log(`  ↳ X image attached: ${path.basename(imgPath)}`);
    } catch (e) {
      if (imageOverride) throw e; // explicit --image fails loudly
      console.warn(`  ↳ X auto-attach failed (publishing text-only): ${e.message}`);
    }
  }

  const rootId = await postTweet(text, null, mediaIds);
  const ledger = loadLedger();
  ledger.push({ file: path.basename(file), rootId, ids: [rootId], teaser: true, truncated, link: link || null, image: mediaIds ? true : false, ts: new Date().toISOString() });
  saveLedger(ledger);
  console.log(`${path.basename(file)}: published (teaser, ${xWeight(text)} weighted${truncated ? ', trimmed' : ''}${link ? '+link' : ''}${mediaIds ? '+image' : '+link card'}) root=${rootId} https://x.com/i/web/status/${rootId}`);
  return rootId;
}

// X has no true in-place edit for non-Premium accounts (edit is Premium-only, 1-hour window) →
// delete + republish. This creates a new tweet id and resets metrics (unlike other channels'
// in-place edits).
async function editPost(id, file, imageOverride) {
  console.log('X edit = delete + republish (true edit requires Premium) — new tweet id, metrics reset');
  await deleteTweet(id);
  await sleep(1500);
  return publish(file, imageOverride);
}

// --- CLI ---
const args = process.argv.slice(2);
const skipDone = args.includes('--skip-done');
const delayIdx = args.indexOf('--delay');
const maxIdx = args.indexOf('--max');
const imageIdx = args.indexOf('--image');
const IMAGE = imageIdx >= 0 ? args[imageIdx + 1] : null;
const INTER_DELAY = delayIdx >= 0 ? Number(args[delayIdx + 1]) * 1000 : 5000; // delay between posts (default 5s)
const MAX_NEW = maxIdx >= 0 ? Number(args[maxIdx + 1]) : Infinity;
const valueIdxs = new Set([delayIdx, maxIdx, imageIdx].filter((i) => i >= 0).map((i) => i + 1));
const files = args.filter((a, i) => !a.startsWith('--') && !valueIdxs.has(i));

if (args[0] === '--preview') { // check the teaser without publishing: node post-api.mjs --preview <file>
  const f = args[1];
  const link = canonicalLink(f);
  const { text, truncated } = buildTeaser(readBody(f), link);
  const img = IMAGE || resolveImage(f)?.imageAbs || null;
  console.log(`--- Teaser (${xWeight(text)}/${LIMIT} weighted${truncated ? ', trimmed' : ''}) ---`);
  console.log(text);
  console.log(`--- Image: ${img ? path.basename(img) + ' (attached → link card suppressed)' : 'none (link card will render)'} ---`);
  process.exit(0);
} else if (args[0] === '--upload-test') { // verify media upload in isolation (no tweet): node post-api.mjs --upload-test <img>
  uploadMedia(args[1]).then((id) => { console.log('media_id', id); process.exit(0); }).catch((e) => { console.error(e.message); process.exit(1); });
} else if (args[0] === '--delete') {
  deleteTweet(args[1]).then((d) => { console.log('deleted', args[1], d); process.exit(0); }).catch((e) => { console.error(e.message); process.exit(1); });
} else if (args[0] === '--edit') {
  editPost(args[1], args[2], IMAGE).then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
} else if (args[0] === '--reply') { // Add a single reply to an existing tweet (non-destructive): node post-api.mjs --reply <tweet-id> "<text>"
  const id = args[1];
  const text = args[2];
  if (!id || !text) { console.error('usage: node post-api.mjs --reply <tweet-id> "<text>"'); process.exit(1); }
  postTweet(text, id, null).then((r) => { console.log('replied', r); process.exit(0); }).catch((e) => { console.error(e.message); process.exit(1); });
} else if (files.length) {
  (async () => {
    const done = new Set(loadLedger().map((e) => e.file));
    let posted = 0;
    for (let i = 0; i < files.length; i++) {
      const base = path.basename(files[i]);
      if (skipDone && done.has(base)) { console.log(`${base}: skip (already published)`); continue; }
      try {
        if (posted > 0) await sleep(INTER_DELAY);
        await publish(files[i], IMAGE);
        posted++;
        if (posted >= MAX_NEW) { console.log(`↳ Reached this run's cap of ${MAX_NEW}.`); break; }
      } catch (e) {
        console.error(`${base}: ${e.message}`);
        // Credits depleted / rate limited / auth failed will keep blocking every subsequent post — stop the batch.
        if (/credits depleted|rate limited|auth failed/i.test(e.message)) {
          console.error(`↳ Publish limit hit — stopping batch (${posted} posted). Resume with --skip-done.`);
          process.exitCode = 1;
          break;
        }
        // Duplicate content means it's already on X → mark it done in the ledger so --skip-done skips it next run.
        if (/duplicate content/i.test(e.message)) {
          const l = loadLedger();
          l.push({ file: base, rootId: null, dup: true, ts: new Date().toISOString() });
          saveLedger(l);
          done.add(base);
          console.error('↳ Duplicate — marked done in ledger (retry will skip it)');
          continue;
        }
        process.exitCode = 1;
      }
    }
  })();
} else {
  console.error('Usage: node post-api.mjs <file.txt> [...] [--image PATH] [--skip-done] [--delay <sec>] [--max <N>] | --edit <id> <file> | --reply <id> "<text>" | --delete <id>');
  process.exit(1);
}
