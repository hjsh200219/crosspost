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
import { measuredTotal } from '../lib/totals.mjs';

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

// The header row renders only once the grid mounts. Its absence means we are not logged in
// as someone who can see this asset, the id is wrong, or the route moved again.
const loadTable = async () => {
  await page.goto(INSIGHTS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return page
    .waitForFunction(
      (label) => [...document.querySelectorAll('[role="columnheader"]')].some((h) => h.innerText.trim().startsWith(label)),
      COL_VIEWS,
      { timeout: 45000 },
    )
    .then(() => true).catch(() => false);
};

// HOW MANY ROWS THIS TABLE RENDERS IS A FUNCTION OF VIEWPORT HEIGHT — not of scrolling, not
// of pagination, and not of the date range. Measured on the live page:
//
//     viewport  743px →   9 rows      viewport  4000px →  25 rows
//     viewport 8000px →  50 rows      viewport 16000px → 100 rows
//
// At every height `clientHeight === scrollHeight`, i.e. the grid has no internal scroll left
// to give: it renders exactly the page of rows that fits and stops. That is why a
// scroll-and-click loop returns the same ~9 rows forever. Four mechanisms were ruled out by
// probe: grid `scrollTop` (moves to its correct max, adds nothing), window scroll, mouse
// wheel, and 30s of waiting. The "load more" control that such a loop clicks belongs to the
// COLUMN PICKER — clicking it adds a column, never a row. `date_preset=`/`since=`/`until=`
// on this route are ignored (the row set does not change).
//
// So grow the viewport instead, on a ladder, stopping as soon as every requested post has a
// row. Above ~16000px the page stops rendering within a sane timeout, so that is the cap —
// coverage beyond it is reported honestly rather than faked.
//
// The override MUST be cleared: the CDP browser is shared with Brunch and Naver, and leaving
// it at 16000px would wreck their layouts. Rung 0 is the browser's own height — it always
// mounts, so its rows are banked before asking for a tall render (Meta intermittently
// refuses those: the shell paints, the grid never mounts).
const VIEWPORT_LADDER = [null, ...(process.env.FB_VIEWPORT_LADDER || '4000,8000,16000').split(',').map(Number)];
const cdp = await ctx.newCDPSession(page);
const setHeight = (h) =>
  cdp.send('Emulation.setDeviceMetricsOverride', { width: 1512, height: h, deviceScaleFactor: 1, mobile: false });
const clearHeight = () => cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});

// The date-range chip is the table's actual measurement window — report the string that was
// read rather than guessing "last 28 days". The pattern demands a real two-sided range (digits,
// a range separator, digits), because "the window we read" is only worth printing if it is the
// window: a loose match grabs the first button carrying a hyphen and reports a confident wrong
// answer, which is worse than the guess it replaced. No match ⇒ null ⇒ the suffix is omitted.
// Override with FB_RANGE_PATTERN if the account's locale renders ranges differently.
const RANGE_PATTERN = process.env.FB_RANGE_PATTERN
  || String.raw`\d{1,4}[^~–—]{0,14}[~–—][^~–—]{0,14}\d{1,4}`;
const readRange = () => page.evaluate((src) => {
  const re = new RegExp(src);
  const t = [...document.querySelectorAll('div[role="button"],span')]
    .map((e) => (e.innerText || '').trim())
    .find((s) => s.length < 60 && re.test(s));
  return t || null;
}, RANGE_PATTERN);

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

let table = { header: [], data: [], scanned: 0 };
let usedHeight = null;
let range = null;
try {
  for (const h of VIEWPORT_LADDER) {
    if (h == null) await clearHeight(); else await setHeight(h);
    // The grid intermittently fails to mount within the timeout even on a healthy session.
    // One retry per rung, then treat it as a failure for this rung.
    let mounted = await loadTable();
    if (!mounted) mounted = await loadTable();
    if (!mounted) {
      // A tall viewport can time out before the grid mounts. If a shorter rung already gave
      // rows, keep those; only the very first failure is fatal.
      if (table.scanned) { console.error(`  (viewport ${h}px: table failed to render — keeping the previous rung's rows)`); break; }
      const shell = await page.evaluate(() => document.body.innerText.slice(0, 200).replace(/\n+/g, ' | '));
      console.error(
        `could not read the Business Suite content table (asset_id=${ASSET_ID}).\n` +
        '  - not logged in, or the account cannot see this Page asset\n' +
        `  - or FACEBOOK_PAGE_ASSET_ID needs the CLASSIC page id (currently "${ASSET_ID}")\n` +
        `  screen: ${shell}`,
      );
      await clearHeight();
      await browser.close();
      process.exit(2);
    }
    // Rows stream in after the header mounts, so a fixed sleep reads a half-built table (the
    // same rung returned 17 rows once and 25 another time). Poll until the count holds steady
    // across two samples. The grid also gets a scroll poke each round — scrolling alone never
    // grows the table, but it is kept as cheap insurance, not as an isolated cause.
    let prev = -1;
    for (let s = 0; s < 14; s++) {
      await page.evaluate(() => { const g = document.querySelector('[role="grid"]'); if (g) g.scrollTop = g.scrollHeight; });
      await page.waitForTimeout(1500);
      const now = await page.evaluate(() => document.querySelectorAll('[role="row"]').length);
      if (now === prev && now > 1) break;
      prev = now;
    }
    table = await readRows();
    usedHeight = h;
    range = (await readRange()) || range;
    console.error(`  (viewport ${h ?? 'native'}px → ${table.scanned} rows · ${table.data.length} Facebook · matched ${matchedCount(table.data)}/${posts.length})`);
    // Stop as soon as every requested post has a row — climbing further costs seconds per
    // rung and risks the render timeout for nothing.
    if (matchedCount(table.data) >= posts.length) break;
  }
} finally {
  // Always restore: the CDP browser is shared with Brunch and Naver.
  await clearHeight();
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
for (const r of rows) {
  console.log(`| ${r.title.slice(0, 30)} | ${r.date} | ${r.views ?? '—'} | ${r.reach ?? '—'} |`);
}
console.log(`| **total (${rows.length})** | | **${measuredTotal(rows, 'views')}** | **${measuredTotal(rows, 'reach')}** |`);
const missed = rows.filter((r) => r.views == null).length;
console.error(
  `(viewport ${usedHeight ?? 'native'}px · scanned ${table.scanned} rows · ${table.data.length} Facebook · resolved ${rows.length - missed}/${rows.length}` +
  `${missed ? ` · ${missed} unresolved may predate the table's date window${range ? ` (${range})` : ''}` : ''})`,
);
console.error('Reach was removed by Meta for content published after 2025-07-31 — a blank reach column is expected.');
