#!/usr/bin/env node
// Publish a text post to the personal profile via LinkedIn API (w_member_social).
// Uses tokens in $CROSSPOST_HOME/.env written by auth.mjs.
//
//   node post-api.mjs posts/x.txt          # publish file
//   node post-api.mjs posts/a.txt b.txt    # publish several
//   node post-api.mjs --image <path> posts/x.txt  # publish with an image attached
//   node post-api.mjs --text "..."         # publish inline text
//   node post-api.mjs --edit <urn> <file>  # replace body of a published post
//   node post-api.mjs --delete <urn>       # delete a post
//   node post-api.mjs --selftest           # create a tiny post then delete it (E2E check)
//   node post-api.mjs --at "YYYY-MM-DD HH:MM" [--comment "..."] <file...>
//                                          # queue for scheduled publish (local time, published by scheduler.mjs)
//   node post-api.mjs --skip-done <file...> # skip files already in the ledger
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { basename, resolve } from 'node:path';
import { dataPath } from '../lib/env.mjs';
import { canonicalLink, linkText } from '../lib/canonical-link.mjs';
import { readPostBody } from '../lib/post-body.mjs';
import { resolveImage } from '../lib/post-image.mjs';
import { parseAccount, loadEnv, accountFile } from './account.mjs';

const { account, rest: ARGV } = parseAccount(process.argv.slice(2));
const authHint = `node auth.mjs${account === 'default' ? '' : ` --account ${account}`}`;
const { pick } = loadEnv(account);
const TOKEN = pick('LINKEDIN_ACCESS_TOKEN');
const AUTHOR = pick('LINKEDIN_PERSON_URN');
const EXP = parseInt(pick('LINKEDIN_TOKEN_EXPIRES') || '0', 10);

if (!TOKEN || !AUTHOR) { console.error(`no token/author for account "${account}" — run: ${authHint}`); process.exit(1); }
if (EXP && Date.now() / 1000 > EXP) { console.error(`access token expired (account ${account}) — run: ${authHint}`); process.exit(1); }

const H = {
  Authorization: `Bearer ${TOKEN}`,
  'X-Restli-Protocol-Version': '2.0.0',
  'Content-Type': 'application/json',
};

// Upload an image (registerUpload → PUT the binary) → returns an asset URN, attached to the ugcPost's media.
async function uploadImageAsset(filePath) {
  if (!existsSync(filePath)) throw new Error(`image not found: ${filePath}`);
  const reg = await fetch('https://api.linkedin.com/v2/assets?action=registerUpload', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      registerUploadRequest: {
        recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
        owner: AUTHOR,
        serviceRelationships: [{ relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' }],
      },
    }),
  });
  if (!reg.ok) throw new Error(`registerUpload ${reg.status}: ${(await reg.text()).slice(0, 300)}`);
  const j = await reg.json();
  const asset = j.value.asset;
  const uploadUrl = j.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}` }, body: readFileSync(filePath) });
  if (!(put.ok || put.status === 201)) throw new Error(`upload PUT ${put.status}: ${(await put.text()).slice(0, 200)}`);
  return asset;
}

async function publish(text, imagePath) {
  const share = {
    shareCommentary: { text },
    shareMediaCategory: imagePath ? 'IMAGE' : 'NONE',
  };
  if (imagePath) {
    const asset = await uploadImageAsset(imagePath);
    share.media = [{ status: 'READY', media: asset }];
  }
  const body = {
    author: AUTHOR,
    lifecycleState: 'PUBLISHED',
    specificContent: { 'com.linkedin.ugc.ShareContent': share },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  };
  const res = await fetch('https://api.linkedin.com/v2/ugcPosts', { method: 'POST', headers: H, body: JSON.stringify(body) });
  const urn = res.headers.get('x-restli-id') || res.headers.get('x-linkedin-id');
  if (!res.ok) throw new Error(`publish ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return urn || (await res.json()).id;
}

// Attach the canonical link as the first comment (a link in the post body hurts reach; a
// first comment doesn't — same approach as comment-api.mjs).
async function comment(urn, text) {
  const res = await fetch(
    `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(urn)}/comments`,
    { method: 'POST', headers: H, body: JSON.stringify({ actor: AUTHOR, message: { text } }) },
  );
  if (!res.ok) throw new Error(`comment ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

// published-linkedin.json ledger — read by stats-fast.mjs (and, per-account, kept separate).
const LEDGER = accountFile('published-linkedin.json', account);

// Ledger date, timezone configurable via TIMEZONE or TZ env (defaults to the system's local
// timezone) — same convention as x/stats.mjs.
const ZONE = process.env.TIMEZONE || process.env.TZ || undefined;
function ledgerDate() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date());
  } catch {
    console.error(`↳ Invalid TIMEZONE/TZ "${ZONE}" — falling back to system local timezone.`);
    return new Intl.DateTimeFormat('en-CA').format(new Date());
  }
}

function recordPublish(file, urn) {
  const list = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : [];
  if (list.some((e) => e.urn === urn)) return;
  list.push({ file, urn, date: ledgerDate() });
  writeFileSync(LEDGER, JSON.stringify(list, null, 2) + '\n');
}

// Replace a published post's body (versioned Posts API partial update — confirmed working
// with w_member_social on 2026-06-10). commentary uses LinkedIn's "Little Text" format, so
// special characters need escaping.
// LinkedIn retires each versioned API version (YYYYMM) roughly a year after release — a
// hardcoded pin eventually dies with 426 NONEXISTENT_VERSION. Walk backwards from the
// current month and use the first version that's still alive (2026-07-21: 202506 had just
// been retired and broke every edit until this fallback was added).
function apiVersions(back = 14) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < back; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

async function edit(urn, text) {
  const escaped = text.replace(/([(){}<>\[\]*_~|@])/g, '\\$1');
  let last = '';
  for (const version of apiVersions()) {
    const res = await fetch(`https://api.linkedin.com/rest/posts/${encodeURIComponent(urn)}`, {
      method: 'POST',
      headers: { ...H, 'X-RestLi-Method': 'PARTIAL_UPDATE', 'LinkedIn-Version': version },
      body: JSON.stringify({ patch: { $set: { commentary: escaped } } }),
    });
    if (res.ok || res.status === 204) return true;
    last = `edit ${res.status}: ${(await res.text()).slice(0, 300)}`;
    if (res.status !== 426) throw new Error(last); // only 426 (version retired) advances to the next version
  }
  throw new Error(last);
}

async function remove(urn) {
  const res = await fetch(`https://api.linkedin.com/v2/ugcPosts/${encodeURIComponent(urn)}`, { method: 'DELETE', headers: H });
  if (!(res.ok || res.status === 204)) throw new Error(`delete ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

// Scheduled-publish queue — scheduler.mjs (your own cron/launchd) publishes due entries.
// The queue is a single file shared across accounts; each entry is tagged with the account
// it should publish under.
const QUEUE = dataPath('ledgers/queue-linkedin.json');
function enqueue(file, whenLocal, comment) {
  if (!existsSync(file)) { console.error(`${file}: not found`); process.exit(1); }
  const m = whenLocal.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/);
  if (!m) { console.error(`--at format: "YYYY-MM-DD HH:MM" (local time), got "${whenLocal}"`); process.exit(1); }
  // No explicit offset → parsed as the system's local time (DST-safe, unlike a hardcoded
  // numeric offset). Stored in the queue as a normal UTC ISO string.
  const localDate = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`);
  if (isNaN(localDate.getTime())) { console.error(`--at is not a valid date: "${whenLocal}"`); process.exit(1); }
  const when = localDate.toISOString();
  if (localDate <= new Date()) { console.error(`--at is in the past: ${when}`); process.exit(1); }
  // 정본 링크 첫 댓글은 발행 시점에 post-api 파일 발행 경로가 스스로 단다. 여기서도
  // 큐에 실으면 scheduler가 같은 댓글을 한 번 더 달아 이중 게시된다 — 큐에는
  // 사용자가 명시한 --comment(추가 댓글)만 싣는다.
  const cmt = comment || null;
  const q = existsSync(QUEUE) ? JSON.parse(readFileSync(QUEUE, 'utf8')) : [];
  // 절대경로로 저장 — scheduler.mjs는 자기 디렉터리로 chdir한 뒤 post-api를 spawn하므로
  // (cron의 cwd도 임의) 상대경로 항목은 발행 시점에 반드시 ENOENT가 난다.
  q.push({ file: resolve(file), when, account, ...(cmt ? { comment: cmt } : {}), queuedAt: new Date().toISOString(), attempts: 0 });
  q.sort((a, b) => a.when.localeCompare(b.when));
  writeFileSync(QUEUE, JSON.stringify(q, null, 2) + '\n');
  console.log(`queued: ${file} → ${when}${cmt ? ' (+comment)' : ''}`);
}

let argv = ARGV; // --account/-a already stripped by parseAccount
// --image <path>: attached image (file-publish path only). Pulled out here, remaining args pass through.
let IMAGE = null;
{
  const i = argv.indexOf('--image');
  if (i >= 0) { IMAGE = argv[i + 1]; argv = [...argv.slice(0, i), ...argv.slice(i + 2)]; }
}

if (argv[0] === '--at') {
  const when = argv[1];
  let rest = argv.slice(2), comment;
  const ci = rest.indexOf('--comment');
  if (ci >= 0) { comment = rest[ci + 1]; rest = [...rest.slice(0, ci), ...rest.slice(ci + 2)]; }
  if (!when || !rest.length) { console.error('usage: post-api.mjs --at "YYYY-MM-DD HH:MM" [--comment "..."] <file...>'); process.exit(1); }
  for (const f of rest) enqueue(f, when, comment);
} else if (argv[0] === '--selftest') {
  const urn = await publish('crosspost API connection test (will be deleted automatically).');
  console.log('created:', urn);
  await new Promise((r) => setTimeout(r, 2500));
  await remove(urn);
  console.log('deleted:', urn, '— publish/delete E2E OK');
} else if (argv[0] === '--delete') {
  await remove(argv[1]);
  console.log('deleted:', argv[1]);
} else if (argv[0] === '--edit') {
  const [, urn, file] = argv;
  if (!urn || !file) { console.error('usage: post-api.mjs --edit <urn> <file>'); process.exit(1); }
  await edit(urn, readPostBody(file));
  console.log('edited:', urn);
} else if (argv[0] === '--text') {
  console.log('published:', await publish(argv[1], IMAGE));
} else if (argv.length) {
  const skipDone = argv.includes('--skip-done');
  const files = argv.filter((a) => a !== '--skip-done');
  if (!files.length) { console.error('usage: post-api.mjs <file...> [--image PATH] [--skip-done]'); process.exit(1); }
  const doneLedger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : [];
  const done = new Set(doneLedger.map((e) => basename(e.file)));
  for (const f of files) {
    if (skipDone && done.has(basename(f))) { console.log(`${f}: skip (already published)`); continue; }
    const text = readPostBody(f); // Korean body + English sibling (.en.txt), if present
    // Image: explicit --image, else auto-resolve a sibling cover image (best-effort — a failed
    // upload must never sink a text post that would otherwise have succeeded).
    const auto = IMAGE ? null : resolveImage(f);
    const imgPath = IMAGE || auto?.imageAbs || null;
    try {
      let urn;
      try {
        urn = await publish(text, imgPath);
      } catch (e) {
        if (imgPath && !IMAGE) { // auto image is best-effort — fall back to text-only
          console.error(`  ↳ auto-image failed → republishing as text-only: ${e.message}`);
          urn = await publish(text, null);
        } else throw e;
      }
      console.log(`${f}: published`, urn, imgPath ? (IMAGE ? '+image' : '+image(auto)') : '');
      if (urn) recordPublish(f, urn);
      const link = canonicalLink(f);
      if (urn && link) {
        try { await comment(urn, `${linkText()}: ${link}`); console.log(`  ↳ first comment: ${link}`); }
        catch (e) { console.error(`  ↳ first comment FAILED: ${e.message}`); }
      }
    }
    catch (e) {
      console.error(`${f}: FAILED`, e.message);
      process.exitCode = 1;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
} else {
  console.error('usage: post-api.mjs <file...> [--image PATH] [--skip-done] | --text "..." | --delete <urn> | --selftest');
  process.exit(1);
}
