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
// 랭킹 호출이 실패하면 조회/댓글/공유를 0으로 채우지 않는다 — 0은 "측정 실패"가 아니라
// "진짜 0"이어야 한다. 실패하면 아래에서 열 전체를 —로 찍고 합계에서 뺀다.
// 한 페이지 200건 상한이라 계정이 크면 잘린다: 장부 항목이 다 매칭될 때까지 페이지를 넘긴다.
let rankingFailed = false;
const ranking = await (async () => {
  const PAGE = 200, MAX_PAGES = 5;
  const out = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await client.get(`https://api.brunch.co.kr/v1/stats/article/ranking?home=${me.userId}&type=view&offset=${page * PAGE}&limit=${PAGE}`);
    if (r.status !== 200) {
      rankingFailed = true;
      console.error(`ranking API failed (HTTP ${r.status}) — view/comment/share columns unavailable`);
      return out;
    }
    let list;
    try { list = JSON.parse(r.text)?.data?.list ?? []; }
    catch (e) {
      rankingFailed = true;
      console.error(`ranking API returned unparseable data (${e.message}) — view/comment/share columns unavailable`);
      return out;
    }
    out.push(...list);
    if (list.length < PAGE) break;
    // 장부에 필요한 항목을 모두 찾았으면 더 넘길 이유가 없다
    const seen = new Set(out.map((x) => String(x.article_no)));
    if (ledger.every((e) => seen.has(String(e.articleNo)))) break;
  }
  return out;
})();
const byArticleNo = new Map();
for (const r of ranking) {
  if (!byArticleNo.has(String(r.article_no))) byArticleNo.set(String(r.article_no), r);
}

// like count isn't in the ranking API — scrape it off each article's own page (public SSR,
// but the page only returns 200 with the session cookie; a cookieless fetch redirect-loops).
// live:false는 두 가지를 뜻할 수 있다 — 정말 삭제됐거나, 조회가 실패했거나.
// 둘을 합치면 네트워크 blip이 "삭제 확인"으로 둔갑해 행이 조용히 사라진다. 구분해서 돌려준다.
async function fetchArticle(no) {
  try {
    const r = await client.get(`https://brunch.co.kr/@${me.profileId}/${no}`);
    if (r.status === 404) return { live: false, deleted: true };
    if (r.status !== 200) return { live: false, error: `HTTP ${r.status}` };
    const html = r.text;
    if (html.includes('잘못된 주소이거나')) return { live: false, deleted: true };
    // like count lives in the SSR-embedded state JSON (\"likeCount\":26); the visible
    // "라이킷" label is rendered client-side and is absent from the raw fetch.
    const lm = html.match(/likeCount\\?":\s*(\d+)/) || html.match(/라이킷\s*(\d+)/);
    const tm = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']/i);
    const title = tm ? tm[1].replace(/\s*[-|]\s*(브런치|brunch).*$/i, '').trim() : null;
    return { live: true, likes: lm ? parseInt(lm[1], 10) : null, title };
  } catch (e) { return { live: false, error: e.message }; }
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
  if (!live) {
    if (art.deleted) { deletedCount++; continue; }
    // 조회 실패는 삭제가 아니다 — 행은 남기되 지표는 미상으로 표시하고 합계에서 뺀다
    console.error(`  ! ${entry.articleNo}: lookup failed (${art.error}) — metrics unknown`);
    rows.push({ title: entry.file, date: entry.date ?? null, view: null, likes: null, comment: null, share: null, unranked: true });
    continue;
  }
  rows.push({
    title: (stat?.title?.replace(/^"|"$/g, '') ?? art.title ?? entry.file),
    date: entry.date || (entry.ts ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(entry.ts)) : null),
    view: stat?.view ?? (rankingFailed ? null : 0),
    likes: art.likes,
    comment: stat?.comment ?? (rankingFailed ? null : 0),
    share: stat?.share ?? (rankingFailed ? null : 0),
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
  console.log(`| ${title}${mark} | ${r.date ?? ''} | ${r.view ?? '—'} | ${r.likes ?? '?'} | ${r.comment ?? '—'} | ${r.share ?? '—'} |`);
}
console.log(`| **Total** | | **${totals.view}** | **${totals.likes}** | **${totals.comment}** | **${totals.share}** |`);
if (deletedCount) console.log(`\n(${deletedCount} ledger entries confirmed deleted/not-live — excluded)`);
if (rankingFailed) console.log('(ranking API unavailable this run — views/comments/shares shown as — and excluded from totals)');
else if (rows.some((r) => r.unranked)) console.log('(* = new post not yet reflected in the Brunch ranking API → views shown as 0. Likes are reflected immediately via SSR, but views are usually indexed within a day. The page is live.)');
