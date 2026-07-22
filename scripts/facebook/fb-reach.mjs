#!/usr/bin/env node
// Scrape Facebook post "조회"(views) from the logged-in Business Suite content-insights
// page via CDP. The Graph API dropped post impression/reach metrics (#100 across
// v18~v23 at the time of writing), so reach is only available in the 1st-party
// dashboard UI.
// LOCALE DEPENDENCY: the scraper matches literal Korean-language labels (조회, 조회 계정,
// 반응, 게시:) rendered by Meta Business Suite's UI, not documented API fields. If your
// Business Suite display language isn't Korean (한국어), every post reports `—`. Set
// business.facebook.com's language to Korean, or edit the labels in EXTRACT() below.
//   node fb-reach.mjs            # recent 20 (ledger date desc)
//   node fb-reach.mjs --limit 0  # all
//   node fb-reach.mjs --fresh    # ignore cache, re-scrape every post
// Perf: parallel tab pool (FB_CONCURRENCY, default 5) + reach cache
// (cache/facebook-reach.json). Posts older than FB_REACH_RECENT_DAYS (default 3) whose
// value is cached are reused (reach on old posts is effectively frozen) — only
// recent/uncached posts are scraped live. First run scrapes all; repeat runs hit
// mostly cache.
// Cache keys are the SHORT numeric postId (the part after `_` in the ledger's
// `pageid_postid`) — looking one up with the full ledger id always misses.
// Negative entries ({miss:true}) expire after FB_REACH_MISS_TTL_DAYS (default 7) so a
// transient failure self-heals instead of freezing a live post at `—` forever.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { loadEnv, dataPath, cdpPort } from '../lib/env.mjs';
import { publishMs } from '../lib/publish-order.mjs';

loadEnv();

// The title is pulled from the local post file's first line rather than the scraped
// insights-page DOM, which often fails or drags in artifacts like "… 더 보기<page name>".
// File-based means cached rows get corrected without a re-fetch, and it stays in sync
// with stats.mjs (same Graph `message` first-line normalization).
const firstLine = (m) => (m || '').split('\n')[0].replace(/^"|"$/g, '').slice(0, 30);

const LEDGER = dataPath('ledgers/published-facebook.json');
const CACHE = dataPath('cache/facebook-reach.json');
const PORT = cdpPort();
const PAGE_ID = process.env.FACEBOOK_PAGE_ID;
if (!PAGE_ID) { console.error('missing FACEBOOK_PAGE_ID in $CROSSPOST_HOME/.env'); process.exit(1); }
// Optional: the Page's display name as shown in Business Suite, used to locate the post
// title next to it on the insights page. If unset, title just falls back to the local
// post file (which is already tried first anyway).
const PAGE_NAME = process.env.FACEBOOK_PAGE_NAME || null;
const CONCURRENCY = Math.max(1, Number(process.env.FB_CONCURRENCY || 5));
const RECENT_DAYS = Number(process.env.FB_REACH_RECENT_DAYS || 3);
// Negative cache TTL — a miss is only trusted this long, then we re-scrape once more.
// Without it a single transient scrape failure would freeze a live post at `—` forever.
const MISS_TTL_DAYS = Number(process.env.FB_REACH_MISS_TTL_DAYS ?? 7);

const args = process.argv.slice(2);
const limitArg = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 20;
const noCache = args.includes('--fresh') || args.includes('--no-cache');

const contentId = (postId) =>
  Buffer.from(`S:_I${PAGE_ID}:${postId}:${postId}`).toString('base64');
const insightsUrl = (postId) =>
  `https://www.facebook.com/content/insights/?content_id=${encodeURIComponent(contentId(postId))}` +
  `&entry_point=CometFeedStoryProfilePlusViewInsightsButton`;

const dateKey = (f) => (String(f || '').match(/(\d{4}-\d{2}-\d{2})/) || [, ''])[1];
const POSTS_DIR = dataPath('posts');
// Local file first line > scraped title > filename.
const postTitle = (file, scraped) => {
  try { return firstLine(readFileSync(path.join(POSTS_DIR, file), 'utf8')) || scraped || file; }
  catch { return scraped || file; }
};
const led = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : [];
let posts = (Array.isArray(led) ? led : Object.values(led)).filter((e) => e && e.id)
  .map((e) => ({ ...e, date: dateKey(e.file) || e.date })); // filename (KST) takes priority — ledger date may be UTC-shifted on old rows
posts.sort((a, b) => publishMs(b) - publishMs(a));
if (limitArg > 0) posts = posts.slice(0, limitArg);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { noDefaults: true });
const ctx = browser.contexts()[0] || (await browser.newContext());
// Reuse an existing Facebook tab (only open a new one if none exists) so we don't spawn
// a fresh tab per lookup. The reused tab is never closed at the end.
const page = ctx.pages().find((p) => p.url().includes('facebook.com')) || ctx.pages()[0] || (await ctx.newPage());

// login check
await page.goto('https://www.facebook.com/professional_dashboard/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
if (/login|checkpoint/.test(page.url())) {
  console.error(`not logged into Facebook on CDP :${PORT} — open the browser and log in, then retry.`);
  await browser.close();
  process.exit(2);
}

// The definition of "조회"(views) is unconfirmed: this reads the label text off the
// Business Suite content-insights page as-is, with no documented mapping to either of
// the retired Graph API metrics (post_impressions / post_impressions_unique) since those
// metrics are gone and can't be cross-checked. A separate "조회 계정"(accounts) figure
// suggests views=total view events and accounts=something closer to unique reach, but
// that's an inference, not a spec — if Meta changes the UI label this scrape silently
// reads a different value.
const EXTRACT = (pageName) => {
  const metric = (label) => {
    const els = [...document.querySelectorAll('div,span')].filter((e) => e.textContent.trim() === label);
    for (const el of els) {
      let n = el.closest('div');
      for (let i = 0; i < 5 && n; i++, n = n.parentElement) {
        const nums = [...n.querySelectorAll('span,div')]
          .map((x) => x.textContent.trim())
          .filter((t) => /^[\d,]+$/.test(t));
        if (nums.length) return Number(nums[0].replace(/,/g, ''));
      }
    }
    return null;
  };
  let title = null;
  if (pageName) {
    const nameEl = [...document.querySelectorAll('span,div,a')].find(
      (e) => e.textContent.trim() === pageName,
    );
    if (nameEl) {
      let c = nameEl;
      for (let i = 0; i < 8 && c; i++, c = c.parentElement) {
        const cand = [...c.querySelectorAll('span,div')]
          .map((x) => x.textContent.trim())
          .filter((t) => t.length > 15 && !t.includes(pageName) && !t.includes('게시:') && !/^\d+시간/.test(t));
        if (cand.length) { title = cand.sort((a, b) => b.length - a.length)[0].slice(0, 30); break; }
      }
    }
  }
  return { views: metric('조회'), accounts: metric('조회 계정'), reactions: metric('반응'), title };
};

// reach cache — reuse frozen reach for old posts, only scrape recent/uncached
let cache = {};
try { cache = JSON.parse(readFileSync(CACHE, 'utf8')); } catch { /* first run */ }
const todayKST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const ageDays = (d) => (d ? Math.round((Date.parse(todayKST) - Date.parse(d)) / 86400000) : 999);

const results = new Map(); // postId -> {date,title,views,accounts,src}
const toScrape = [];
for (const p of posts) {
  const postId = p.id.split('_')[1];
  const c = cache[postId];
  // Reuse if old (>RECENT_DAYS) and cached — a positive value is frozen forever (reach on
  // old posts doesn't move), but a negative (miss) is only trusted for MISS_TTL_DAYS. A
  // miss can be a genuinely dead/deleted id OR a transient scrape failure, and we can't
  // tell them apart at write time — so we re-check periodically instead of trusting it
  // permanently. Gate on c.ts (when the miss was recorded), NOT p.date: a post published
  // long ago whose miss was written yesterday must stay cached until the TTL elapses.
  const missFresh = c?.miss && Date.now() - Date.parse(c.ts) < MISS_TTL_DAYS * 86400000;
  const reuse = !noCache && c && ageDays(p.date) > RECENT_DAYS && (c.views != null || missFresh);
  if (reuse) {
    const views = c.miss ? null : c.views;
    const title = postTitle(p.file, c.title);
    results.set(postId, { date: p.date, title, views, accounts: c.miss ? null : (c.accounts ?? null), src: 'cache' });
    console.error(`  [cache] ${p.date}  views ${views ?? '—'}  ${title.slice(0, 24)}`);
  } else {
    toScrape.push({ ...p, postId });
  }
}

// parallel tab pool — worker 0 reuses the login tab, rest are fresh tabs (closed at end)
const scrapeOne = async (pg, p) => {
  let r = null;
  try {
    await pg.goto(insightsUrl(p.postId), { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 14; i++) { // poll until 조회 renders (evaluate can race SPA nav → retry)
      try { r = await pg.evaluate(EXTRACT, PAGE_NAME); if (r.views !== null) break; } catch { /* context destroyed — retry */ }
      await pg.waitForTimeout(500);
    }
  } catch { /* nav failure — leave r null */ }
  r = r || {};
  const title = postTitle(p.file, r.title);
  results.set(p.postId, { date: p.date, title, views: r.views, accounts: r.accounts, src: 'live' });
  cache[p.postId] = r.views != null
    ? { views: r.views, accounts: r.accounts ?? null, title: r.title || null, date: p.date, ts: new Date().toISOString() }
    : { miss: true, title: r.title || null, date: p.date, ts: new Date().toISOString() }; // negative cache — trusted for MISS_TTL_DAYS from this ts, then re-scraped once more
  console.error(`  [live]  ${p.date}  views ${r.views ?? '—'}  ${title.slice(0, 24)}`);
};

const createdPages = [];
if (toScrape.length) {
  const pool = [page];
  for (let i = 1; i < Math.min(CONCURRENCY, toScrape.length); i++) { const np = await ctx.newPage(); pool.push(np); createdPages.push(np); }
  let idx = 0;
  const worker = async (pg) => { for (let my = idx++; my < toScrape.length; my = idx++) await scrapeOne(pg, toScrape[my]); };
  await Promise.all(pool.map(worker));
}

try { writeFileSync(CACHE, JSON.stringify(cache, null, 0)); } catch { /* non-fatal */ }

// table (posts order = date desc)
const rows = posts.map((p) => results.get(p.id.split('_')[1])).filter(Boolean);
console.log('| title | date | views | viewers |');
console.log('| --- | --- | --: | --: |');
let tv = 0, ta = 0;
for (const r of rows) {
  tv += r.views || 0; ta += r.accounts || 0;
  console.log(`| ${r.title} | ${r.date} | ${r.views ?? '—'} | ${r.accounts ?? '—'} |`);
}
console.log(`| **total (${rows.length})** | | **${tv}** | **${ta}** |`);
const nLive = rows.filter((r) => r.src === 'live').length;
console.error(`(live ${nLive} · cache ${rows.length - nLive}, concurrency ${CONCURRENCY})`);

for (const np of createdPages) await np.close().catch(() => {}); // only close newly-opened tabs (leave the original tab/browser alone)
await browser.close(); // disconnect only (browser stays running)
