#!/usr/bin/env node
// Facebook per-post view counts from the Business Suite Insights → Content table, via CDP.
// The Graph API has no post-level impression/reach metric — every candidate
// (post_impressions*, post_reach, post_activity, post_engaged_users…) answers
// `(#100) The value must be a valid insights metric` on v23/v24 even with read_insights on a
// permanent PAGE token (re-verified 2026-07-27). So the dashboard UI stays the only source.
//
// LOCALE DEPENDENCY: this reads literal Korean column headers (조회수, 도달) rendered by
// Business Suite. If your display language isn't Korean, set business.facebook.com to Korean
// or edit COL_VIEWS / COL_REACH below.
//
//   node fb-reach.mjs            # recent 20 (ledger date desc)
//   node fb-reach.mjs --limit 0  # all
//   node fb-reach.mjs --fresh    # ignore cache, re-scrape
//
// 2026-07-27 rewrite. Two things changed at once upstream, and together they made the old
// per-post scraper report `—` for every post:
//   1) The per-post route (facebook.com/content/insights/?content_id=S:_I<pageId>:<postId>…)
//      now answers "this content isn't available right now" for EVERY actor-id spelling.
//      The live route is the Business Suite table, keyed by the Page's CLASSIC id — which is
//      NOT the New-Pages-Experience display id that the content_id was built from. Set
//      FACEBOOK_PAGE_ASSET_ID if the two differ for your Page (it defaults to
//      FACEBOOK_PAGE_ID). The classic id is the prefix of the ledger's `<pageId>_<postId>`.
//   2) Meta removed reach from Business Suite for content published after 2025-07-31 (the
//      table shows a banner saying so and the 도달 column renders ‑‑). Views are what remain,
//      so views are what we report; reach is still read and shown when Meta happens to have it.
// One table load covers every recent post, so this is also 1 page load instead of N.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { loadEnv, dataPath, cdpPort } from '../lib/env.mjs';
import { publishMs } from '../lib/publish-order.mjs';

loadEnv();

// The title is pulled from the local post file's first line rather than the scraped DOM,
// which drags in artifacts like "… 더 보기<page name>". File-based means cached rows get
// corrected without a re-fetch, and it stays in sync with stats.mjs.
const firstLine = (m) => (m || '').split('\n')[0].replace(/^"|"$/g, '').trim();

const LEDGER = dataPath('ledgers/published-facebook.json');
const CACHE = dataPath('cache/facebook-reach.json');
const PORT = cdpPort();
const PAGE_ID = process.env.FACEBOOK_PAGE_ID;
if (!PAGE_ID) { console.error('missing FACEBOOK_PAGE_ID in $CROSSPOST_HOME/.env'); process.exit(1); }
// Business Suite keys this view by the CLASSIC page id. On New Pages Experience the display
// id differs, and the wrong one renders "this content isn't available right now".
const ASSET_ID = process.env.FACEBOOK_PAGE_ASSET_ID || PAGE_ID;
const INSIGHTS_URL = `https://business.facebook.com/latest/insights/content?asset_id=${ASSET_ID}`;
const COL_VIEWS = process.env.FB_COL_VIEWS || '조회수';
const COL_REACH = process.env.FB_COL_REACH || '도달';

const args = process.argv.slice(2);
const limitArg = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 20;
const noCache = args.includes('--fresh') || args.includes('--no-cache');

const dateKey = (f) => (String(f || '').match(/(\d{4}-\d{2}-\d{2})/) || [, ''])[1];
const POSTS_DIR = dataPath('posts');
const postBody = (file) => { try { return readFileSync(path.join(POSTS_DIR, file), 'utf8'); } catch { return ''; } };
const postTitle = (file) => firstLine(postBody(file)) || file;
// Rows are keyed by the published caption. Whitespace and quote glyphs differ between the
// local file and the DOM render, so both sides are stripped before comparing.
const norm = (s) => (s || '').replace(/\s+/g, '').replace(/[“”"'’·…]/g, '').slice(0, 40);

const led = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : [];
let posts = (Array.isArray(led) ? led : Object.values(led)).filter((e) => e && e.id)
  .map((e) => ({ ...e, date: dateKey(e.file) || e.date })); // filename (KST) takes priority — ledger date may be UTC-shifted on old rows
posts.sort((a, b) => publishMs(b) - publishMs(a));
if (limitArg > 0) posts = posts.slice(0, limitArg);

let cache = {};
if (!noCache) { try { cache = JSON.parse(readFileSync(CACHE, 'utf8')); } catch { /* first run */ } }

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { noDefaults: true });
const ctx = browser.contexts()[0] || (await browser.newContext());
const page = ctx.pages().find((p) => p.url().includes('facebook.com')) || ctx.pages()[0] || (await ctx.newPage());

await page.goto(INSIGHTS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
// The header row renders only once the grid mounts. Its absence means we are not logged in
// as someone who can see this asset, the id is wrong, or the route moved again.
const ok = await page
  .waitForFunction(
    (label) => [...document.querySelectorAll('[role="columnheader"]')].some((h) => h.innerText.trim().startsWith(label)),
    COL_VIEWS,
    { timeout: 45000 },
  )
  .then(() => true).catch(() => false);
if (!ok) {
  const shell = await page.evaluate(() => document.body.innerText.slice(0, 200).replace(/\n+/g, ' | '));
  console.error(
    `could not read the Business Suite content table (asset_id=${ASSET_ID}).\n` +
    '  - not logged in, or the account cannot see this Page asset\n' +
    `  - or FACEBOOK_PAGE_ASSET_ID needs the CLASSIC page id (currently "${ASSET_ID}")\n` +
    `  screen: ${shell}`,
  );
  await browser.close();
  process.exit(2);
}

// The grid lazy-loads: read → scroll → re-read until two rounds add nothing.
//
// CRITICAL: this table mixes the Facebook Page and a connected Instagram account, and the
// same article goes out to both with the same opening line. Matching on caption alone
// silently binds Facebook ledger rows to Instagram numbers. Each row carries an
// <img alt="Facebook"> / alt="Instagram"> platform badge, so we keep only Facebook rows.
const readRows = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('[role="row"]')];
  if (!rows.length) return { header: [], data: [], scanned: 0 };
  const cellsOf = (r) => [...r.querySelectorAll('[role="gridcell"],[role="columnheader"]')].map((c) => c.innerText.trim());
  const platformOf = (r) => [...r.querySelectorAll('img')].map((i) => i.getAttribute('alt') || '')
    .find((a) => a === 'Facebook' || a === 'Instagram') || '';
  const header = cellsOf(rows[0]).map((h) => h.split('\n')[0].trim());
  const all = rows.slice(1).map((r) => ({ cells: cellsOf(r), platform: platformOf(r) })).filter((r) => r.cells.length > 2);
  return { header, data: all.filter((r) => r.platform === 'Facebook').map((r) => r.cells), scanned: all.length };
});

// The grid is its own scroll container (the <table> carries overflow-y:auto) and paginates
// behind a "더 보기" button — scrolling the window does nothing, which is why a naive
// window.scrollTo loop only ever saw the first ~9 rows.
const MORE_LABEL = process.env.FB_MORE_LABEL || '더 보기';
const grow = () => page.evaluate((label) => {
  const g = document.querySelector('[role="grid"]');
  if (g) g.scrollTop = g.scrollHeight;
  const more = [...document.querySelectorAll('div[role="button"],a')].find((x) => x.innerText.trim() === label);
  if (more) { more.click(); return true; }
  return false;
}, MORE_LABEL);

const indexOf = (data) => {
  const byCaption = new Map();
  for (const cells of data) {
    const key = norm(cells[0]);
    if (key && !byCaption.has(key)) byCaption.set(key, cells);
  }
  return byCaption;
};
const lookup = (byCaption, body) => {
  const key = norm(body);
  if (!key) return null;
  if (byCaption.has(key)) return byCaption.get(key);
  // captions get truncated with an ellipsis at different lengths, so fall back to a prefix hit
  for (const [k, v] of byCaption) if (k.startsWith(key.slice(0, 24)) || key.startsWith(k.slice(0, 24))) return v;
  return null;
};
const bodies = posts.map((p) => postBody(p.file));
const matchedCount = (data) => { const idx = indexOf(data); return bodies.filter((b) => lookup(idx, b)).length; };

let table = await readRows();
for (let i = 0, stagnant = 0; i < 40 && stagnant < 3; i++) {
  // Stop as soon as every requested post has a row — the default ask is the recent 20, which
  // sit near the top, so scanning the whole history would waste most of the run.
  if (matchedCount(table.data) >= posts.length) break;
  // grow on TOTAL rows scanned, not the Facebook subset — several consecutive pages can be
  // all-Instagram, and stopping on those would cut the scan short.
  const before = table.scanned;
  await grow();
  await page.waitForTimeout(1500);
  table = await readRows();
  if (table.scanned <= before) stagnant++; else stagnant = 0;
}
await browser.close(); // disconnect only — the shared browser keeps running

const colIdx = (label) => table.header.findIndex((h) => h === label);
const iViews = colIdx(COL_VIEWS);
const iReach = colIdx(COL_REACH);
const num = (s) => (/^[\d,]+$/.test((s || '').trim()) ? Number(s.replace(/,/g, '')) : null);

const byCaption = indexOf(table.data);
const rows = [];
for (const p of posts) {
  const postId = String(p.id).split('_')[1];
  const row = lookup(byCaption, postBody(p.file));
  let views = row && iViews >= 0 ? num(row[iViews]) : null;
  let reach = row && iReach >= 0 ? num(row[iReach]) : null;
  let src = row ? 'live' : 'miss';
  // Posts outside the table's date window (default: last 28 days) keep their last measured
  // value rather than regressing to `—`; views on an old post are effectively frozen anyway.
  if (views == null && cache[postId]?.views != null) { views = cache[postId].views; reach = cache[postId].reach ?? null; src = 'cache'; }
  if (row && views != null) cache[postId] = { views, reach, date: p.date, ts: new Date().toISOString() };
  rows.push({ title: postTitle(p.file), date: p.date, views, reach, src });
  console.error(`  [${src.padEnd(5)}] ${p.date}  views ${views ?? '—'}  ${postTitle(p.file).slice(0, 24)}`);
}

try { writeFileSync(CACHE, JSON.stringify(cache, null, 0)); } catch { /* non-fatal */ }

console.log('| title | date | views | reach |');
console.log('| --- | --- | --: | --: |');
let tv = 0, tr = 0;
for (const r of rows) {
  tv += r.views || 0; tr += r.reach || 0;
  console.log(`| ${r.title.slice(0, 30)} | ${r.date} | ${r.views ?? '—'} | ${r.reach ?? '—'} |`);
}
console.log(`| **total (${rows.length})** | | **${tv}** | **${tr}** |`);
const missed = rows.filter((r) => r.views == null).length;
console.error(
  `(scanned ${table.scanned} rows · ${table.data.length} Facebook · resolved ${rows.length - missed}/${rows.length}` +
  `${missed ? ` · ${missed} unresolved may predate the table window (default: last 28 days)` : ''})`,
);
console.error('Reach was removed by Meta for content published after 2025-07-31 — a blank reach column is expected.');
