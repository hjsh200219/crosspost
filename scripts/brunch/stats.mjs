#!/usr/bin/env node
// Brunch post stats — BROWSERLESS. Uses the same internal endpoints the "통계" dashboard
// calls, but over plain node fetch with a persisted session cookie (cookie.mjs) instead
// of driving a CDP Chromium. Steady-state = env BRUNCH_COOKIE → ~0.2s, no browser. On a
// stale cookie (401) it self-heals once via CDP /kakao/login re-mint (human-free while
// the Kakao SSO is alive), re-persists, and retries.
//
// Usage:
//   node stats.mjs                # ledger entries (published-brunch.json), date desc
//   node stats.mjs --limit 0      # all ledger entries (default: 20)
//   node stats.mjs --limit 5
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { loadEnv, home, dataPath, cdpPort } from '../lib/env.mjs';
import { openBrunch } from './cookie.mjs';

loadEnv();

const PORT = cdpPort();
const ENV_PATH = path.join(home(), '.env');
const LEDGER = dataPath('ledgers/published-brunch.json');

const argv = process.argv.slice(2);
let limit = 20;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--limit') { limit = parseInt(argv[++i], 10); }
}

if (!existsSync(LEDGER)) { console.error('no published-brunch.json ledger — nothing published yet.'); process.exit(0); }
let ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
ledger = ledger.filter((e) => e.articleNo && e.status === 'publish').sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
if (limit > 0) ledger = ledger.slice(0, limit);
if (!ledger.length) { console.log('no published posts'); process.exit(0); }

// --- auth: env browserless fast path → in-page CDP fetch (see cookie.mjs openBrunch) ---
// Brunch's API authenticates only from a live brunch.co.kr document, so every call below
// goes through client.get (browserless when the env cookie still node-fetches, else the
// CDP in-page path). client.get returns { status, text } regardless of path.
let client;
try { client = await openBrunch({ envPath: ENV_PATH, port: PORT }); }
catch (e) { console.error(`Brunch session failed — ${e.message}`); process.exit(2); }
const me = client.me;
console.error(`cookie src: ${client.src === 'env' ? 'env (browserless)' : 'cdp (in-page)'}`);

// --- view/share/comment for every live article in one ranking call ---
// The ranking API can both duplicate some article_no entries and drop others while still
// reporting the correct total — dedupe defensively, and don't trust "missing from ranking"
// alone to mean deleted (per-entry live-check below confirms).
const ranking = await (async () => {
  const r = await client.get(`https://api.brunch.co.kr/v1/stats/article/ranking?home=${me.userId}&type=view&offset=0&limit=200`);
  if (r.status !== 200) return [];
  try { return JSON.parse(r.text)?.data?.list ?? []; } catch { return []; }
})();
const byArticleNo = new Map();
for (const r of ranking) {
  if (!byArticleNo.has(String(r.article_no))) byArticleNo.set(String(r.article_no), r);
}

// like count isn't in the ranking API — scrape it off each article's own page (public SSR,
// but the page only returns 200 with the session cookie; a cookieless fetch redirect-loops).
async function fetchArticle(no) {
  try {
    const r = await client.get(`https://brunch.co.kr/@${me.profileId}/${no}`);
    if (r.status !== 200) return { live: false };
    const html = r.text;
    if (html.includes('잘못된 주소이거나')) return { live: false };
    // like count lives in the SSR-embedded state JSON (\"likeCount\":26); the visible
    // "라이킷" label is rendered client-side and is absent from the raw fetch.
    const lm = html.match(/likeCount\\?":\s*(\d+)/) || html.match(/라이킷\s*(\d+)/);
    const tm = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']/i);
    const title = tm ? tm[1].replace(/\s*[-|]\s*(브런치|brunch).*$/i, '').trim() : null;
    return { live: true, likes: lm ? parseInt(lm[1], 10) : null, title };
  } catch { return { live: false }; }
}

// small concurrency pool over the page fetches
async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

const enriched = await mapPool(ledger, 6, async (entry) => {
  const stat = byArticleNo.get(String(entry.articleNo));
  const art = await fetchArticle(entry.articleNo);
  return { entry, stat, art };
});
await client.close();

const rows = [];
let deletedCount = 0;
for (const { entry, stat, art } of enriched) {
  const live = stat ? true : art.live; // in ranking ⇒ live; else trust the page check
  if (!live) { deletedCount++; continue; }
  rows.push({
    title: (stat?.title?.replace(/^"|"$/g, '') ?? art.title ?? entry.file),
    date: entry.date || (entry.ts ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(entry.ts)) : null),
    view: stat?.view ?? 0, likes: art.likes, comment: stat?.comment ?? 0, share: stat?.share ?? 0,
    unranked: !stat,
  });
}

const totals = rows.reduce((a, r) => ({
  view: a.view + (r.view || 0), likes: a.likes + (r.likes || 0), comment: a.comment + (r.comment || 0), share: a.share + (r.share || 0),
}), { view: 0, likes: 0, comment: 0, share: 0 });

console.log('| title | date | views | likes | comments | shares |');
console.log('|---|---|--:|--:|--:|--:|');
for (const r of rows) {
  const title = r.title.length > 30 ? r.title.slice(0, 30) + '…' : r.title;
  const mark = r.unranked ? '*' : '';
  console.log(`| ${title}${mark} | ${r.date ?? ''} | ${r.view} | ${r.likes ?? '?'} | ${r.comment} | ${r.share} |`);
}
console.log(`| **Total** | | **${totals.view}** | **${totals.likes}** | **${totals.comment}** | **${totals.share}** |`);
if (deletedCount) console.log(`\n(${deletedCount} ledger entries confirmed deleted/not-live — excluded)`);
if (rows.some((r) => r.unranked)) console.log('(* = new post not yet reflected in the Brunch ranking API → views shown as 0. Likes are reflected immediately via SSR, but views are usually indexed within a day. The page is live.)');
