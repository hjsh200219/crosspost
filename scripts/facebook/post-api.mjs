#!/usr/bin/env node
// Publish a post to a Facebook Page via the Graph API.
// Reads FACEBOOK_PAGE_ID / FACEBOOK_PAGE_ACCESS_TOKEN from $CROSSPOST_HOME/.env
// (run get-page-token.mjs once to populate the token).
//
//   node post-api.mjs posts/2026-07-07_x.txt                      # publish (auto canonical link)
//   node post-api.mjs --image <path> file.txt                     # publish as a photo post (image + caption)
//   node post-api.mjs --link https://... file.txt                 # override link
//   node post-api.mjs --backdate 2026-06-15 file.txt              # backdated_time (history backfill)
//   node post-api.mjs --skip-done file.txt                        # skip if file already in ledger
//   node post-api.mjs --delete <post-id>                          # delete a post
//   node post-api.mjs --edit <post-id> file.txt                   # replace a published post's body text
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { loadEnv, dataPath } from '../lib/env.mjs';
import { canonicalLink } from '../lib/canonical-link.mjs';
import { readPostBody } from '../lib/post-body.mjs';
import { resolveImage } from '../lib/post-image.mjs';

loadEnv();

const LEDGER = dataPath('ledgers/published-facebook.json');
const GRAPH = 'https://graph.facebook.com/v21.0';

const PAGE_ID = process.env.FACEBOOK_PAGE_ID;
const TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
if (!PAGE_ID || !TOKEN) {
  console.error('missing FACEBOOK_PAGE_ID / FACEBOOK_PAGE_ACCESS_TOKEN in $CROSSPOST_HOME/.env — run get-page-token.mjs first');
  process.exit(1);
}

const args = process.argv.slice(2);
const flagVal = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };

// --- delete ---
const delId = flagVal('--delete');
if (delId) {
  const r = await fetch(`${GRAPH}/${delId}?access_token=${encodeURIComponent(TOKEN)}`, { method: 'DELETE' });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  const confirmed = data === true || data?.success === true;
  if (!r.ok || data?.error || !confirmed) {
    console.error(`delete ${r.status}: ${data?.error ? JSON.stringify(data.error) : text.slice(0, 300)}`);
    process.exit(1);
  }
  if (existsSync(LEDGER)) {
    const ledger = JSON.parse(readFileSync(LEDGER, 'utf8')).filter((entry) => entry.id !== delId);
    writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n');
  }
  console.log(`deleted: ${delId}`);
  process.exit(0);
}

// --- edit ---
// Graph API POST /{post-id} with message=<body> replaces a published post's text.
// Bilingual like the publish path (readPostBody appends the English `.en.txt`
// sibling below a divider) so the edited body matches how the post was published.
// Message only: a published post's link attachment cannot be changed via edit,
// so we don't re-apply the canonical link.
const editIdx = args.indexOf('--edit');
if (editIdx !== -1) {
  const postId = args[editIdx + 1];
  const editFile = args[editIdx + 2];
  if (!postId || !editFile) {
    console.error('usage: node post-api.mjs --edit <post-id> <file>');
    process.exit(1);
  }
  if (!existsSync(editFile)) { console.error(`file not found: ${editFile}`); process.exit(1); }
  const message = readPostBody(editFile);
  const body = new URLSearchParams({ message, access_token: TOKEN });
  const r = await fetch(`${GRAPH}/${postId}`, { method: 'POST', body });
  const d = await r.json();
  if (d.error) { console.error(JSON.stringify(d.error)); process.exit(1); }
  console.log(`edited: ${postId}`);
  process.exit(0);
}

// --- publish ---
const linkOverride = flagVal('--link');
const backdate = flagVal('--backdate');
const image = flagVal('--image');
const skipDone = args.includes('--skip-done');
const flagsWithVal = new Set(['--link', '--backdate', '--image']);
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && flagsWithVal.has(args[i - 1])));
if (!files.length) {
  console.error('usage: node post-api.mjs [--image PATH] [--link URL] [--backdate YYYY-MM-DD] [--skip-done] <file.txt> ...');
  process.exit(1);
}
if (image && !existsSync(image)) { console.error(`image not found: ${image}`); process.exit(1); }

const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : [];
const done = new Set(ledger.map((e) => e.file));

async function publish(message, linkUrl, backdateIso) {
  const body = new URLSearchParams({ message, access_token: TOKEN });
  if (linkUrl) body.set('link', linkUrl);
  if (backdateIso) {
    body.set('backdated_time', backdateIso);
    body.set('backdated_time_granularity', 'day');
  }
  const r = await fetch(`${GRAPH}/${PAGE_ID}/feed`, { method: 'POST', body });
  const d = await r.json();
  if (d.error) throw new Error(JSON.stringify(d.error));
  return d;
}

// Photo post: /{page}/photos with a binary (source) + caption (message). The
// returned post_id is the feed post's id, which is what we record in the ledger.
async function publishPhoto(message, imagePath, backdateIso) {
  const fd = new FormData();
  fd.set('access_token', TOKEN);
  fd.set('caption', message);
  fd.set('published', 'true');
  if (backdateIso) { fd.set('backdated_time', backdateIso); fd.set('backdated_time_granularity', 'day'); }
  const buf = readFileSync(imagePath);
  const name = imagePath.split('/').pop() || 'image';
  const type = /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';
  fd.set('source', new Blob([buf], { type }), name);
  const r = await fetch(`${GRAPH}/${PAGE_ID}/photos`, { method: 'POST', body: fd });
  const d = await r.json();
  if (d.error) throw new Error(JSON.stringify(d.error));
  return { id: d.post_id || d.id }; // post_id = the id of the resulting feed post
}

// Text feed post + backdate-before-page-creation rejection (1607025) fallback to now.
async function publishTextWithBackdateFallback(message, link, backdateIso, base) {
  try {
    return { res: await publish(message, link, backdateIso), dated: !!backdateIso };
  } catch (err) {
    if (backdateIso && /1607025/.test(err.message)) {
      console.log(`  (${base}: backdate < page creation → posted at now)`);
      return { res: await publish(message, link, null), dated: false };
    }
    throw err;
  }
}

for (const f of files) {
  const base = path.basename(f);
  if (skipDone && done.has(base)) { console.log(`${base}: skip (already posted)`); continue; }
  const message = readPostBody(f); // Korean body + English sibling (.en.txt), same convention as LinkedIn
  const link = linkOverride || canonicalLink(f) || null;
  const backdateIso = backdate ? `${backdate}T12:00:00+0900` : null;
  // Image: explicit --image (fails loudly on error) or auto-resolved sibling image
  // (best-effort — falls back to text on failure so a missing/broken image never
  // sinks a post that would otherwise succeed).
  const auto = image ? null : resolveImage(f);
  const imgPath = image || auto?.imageAbs || null;
  let res, dated = !!backdate;
  if (imgPath) {
    // Photo post — the canonical link (if any) is appended to the caption since photo
    // posts don't get a link preview attached.
    const caption = link ? `${message}\n\n${link}` : message;
    try {
      res = await publishPhoto(caption, imgPath, backdateIso);
      console.log(`${base}: published id=${res.id} +image${auto ? '(auto)' : ''}${link ? ' +link(caption)' : ''}${dated ? ' @' + backdate : ''}`);
    } catch (err) {
      if (image) throw err; // explicit --image fails loudly
      // auto-image is best-effort — fall back to a text post
      console.error(`  (${base}: auto-image failed → publishing as text: ${String(err.message).replace(/\s+/g, ' ').slice(0, 120)})`);
      ({ res, dated } = await publishTextWithBackdateFallback(message, link, backdateIso, base));
      console.log(`${base}: published id=${res.id}${link ? ' +link' : ''}${dated ? ' @' + backdate : ''} (text-only fallback)`);
    }
  } else {
    ({ res, dated } = await publishTextWithBackdateFallback(message, link, backdateIso, base));
    console.log(`${base}: published id=${res.id}${link ? ' +link' : ''}${dated ? ' @' + backdate : ''}`);
  }
  ledger.push({
    file: base,
    id: res.id,
    link: link || null,
    date: backdate || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()),
    publishedAt: backdateIso ? new Date(backdateIso).toISOString() : new Date().toISOString(),
  });
  done.add(base);
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n');
}
