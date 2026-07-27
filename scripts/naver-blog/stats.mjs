// Naver blog per-post stats (views · likes · comments) for ledger posts — browserless.
//   node stats.mjs                 # all ledger posts (views = yesterday, last finalized day)
//   node stats.mjs <logNo>         # one post
//   node stats.mjs --date 2026-07-13   # views for a specific finalized date
//
// Metrics: views from the owner stats API (blog.stat.naver.com/api/blog/article/cv, the same
// source as 관리 > 통계 > 게시물 조회수), likes via the blogserver like API, comments from the
// m.blog post document. Naver finalizes view stats DAILY with a lag — a post published today
// shows views starting from the next day's finalized data.
//
// 2026-07-27: CDP in-page fetch → plain node fetch with the session cookie. The cross-origin
// wall that forced in-page fetches only exists in a browser; server-side there is no CORS, so
// the same endpoints answer directly (3 calls ≈ 0.3s, no browser). The one exception is the
// comment count: the cbox JSONP endpoint rejects a server-side call with `4001 Wrong ticket`
// no matter the referer/sec-fetch headers, so it is read from the m.blog document instead
// (`<div id="_post_property" commentCount="N">`), which is the number the widget renders.
// CDP is still used once to (re)capture cookies when the stored one expires.
import { existsSync, readFileSync } from 'fs';
import { chromium } from 'playwright';
import { loadEnv, dataPath, cdpPort } from '../lib/env.mjs';
import { publishMs } from '../lib/publish-order.mjs';
import { resolveCookie } from '../lib/site-cookie.mjs';

loadEnv();

const LEDGER = dataPath('ledgers/published-naver.json');
const BLOG_ID = process.env.NAVER_BLOG_ID;
if (!BLOG_ID) { console.error('NAVER_BLOG_ID not set in $CROSSPOST_HOME/.env'); process.exit(1); }
// NID_AUT+NID_SES carry the login; NID_JST/NNB come along because the stat origin sets them.
const COOKIE_NAMES = ['NID_AUT', 'NID_SES', 'NID_JST', 'NNB'];
const UA_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 6));

const argv = process.argv.slice(2);
const dateIdx = argv.indexOf('--date');
// The cv API returns a trailing ~15-day daily window ending at startDate; summing it
// gives each post's views over that window. Default endDate = today (KST); same-day is
// delayed by Naver, so a post published today may still read 0 until the next day.
const todayKST = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const viewDate = dateIdx !== -1 ? argv[dateIdx + 1] : todayKST();
const only = argv.find((a) => /^\d{9,}$/.test(a));
const limIdx = argv.indexOf('--limit');
const LIMIT = limIdx !== -1 ? Number(argv[limIdx + 1]) : 20; // recent 20 by default (matches other channels); --limit 0 = all

const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : [];
let posts = (only ? ledger.filter((e) => e.logNo === only) : ledger)
  .sort((a, b) => publishMs(b) - publishMs(a));
if (!only && LIMIT > 0) posts = posts.slice(0, LIMIT);
if (!posts.length) { console.log('no ledger posts (published-naver.json is empty).'); process.exit(0); }

let { cookie, src } = await resolveCookie({
  key: 'NAVER_COOKIE', port: cdpPort(), chromium,
  origins: ['https://blog.naver.com', 'https://blog.stat.naver.com', 'https://naver.com'],
  names: COOKIE_NAMES,
});

const get = (url, { ua = UA_DESKTOP, referer } = {}) =>
  fetch(url, { headers: { cookie, 'user-agent': ua, ...(referer ? { referer } : {}) } });

// Retry before giving up: `—`(null) must mean "measurement failed", never "a request
// blipped". Without this a single transient throttle prints an em dash next to real zeros
// and the two become indistinguishable in the report.
async function withRetry(fn, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v != null) return v;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  return null;
}

async function viewsOnce(logNo) {
  try {
    const r = await get(
      `https://blog.stat.naver.com/api/blog/article/cv?timeDimension=DATE&startDate=${viewDate}&contentId=${logNo}`,
      { referer: `https://blog.stat.naver.com/blog/article/${logNo}/cv` },
    );
    const j = await r.json();
    const cv = j?.result?.statDataList?.[0]?.data?.rows?.cv;
    return Array.isArray(cv) ? cv.reduce((s, x) => s + (Number(x) || 0), 0) : null;
  } catch { return null; }
}
const viewsOf = (logNo) => withRetry(() => viewsOnce(logNo));

async function likesOf(logNo) {
  try {
    const r = await get(
      `https://apis.naver.com/blogserver/like/v1/search/contents?suppress_response_codes=true&q=BLOG%5B${BLOG_ID}_${logNo}%5D&pool=blogid`,
      { referer: `https://blog.naver.com/${BLOG_ID}/${logNo}` },
    );
    const c = (await r.json())?.contents?.[0];
    if (c?.reactions?.length) return c.reactions.reduce((s, x) => s + (x.count || 0), 0);
    if (typeof c?.likeItCount === 'number') return c.likeItCount;
    return 0;
  } catch { return 0; }
}

// The mobile post document carries the count as a plain attribute on #_post_property —
// no widget render needed, and it matches what the cbox widget would have reported.
async function commentsOf(logNo) {
  try {
    const html = await (await get(`https://m.blog.naver.com/${BLOG_ID}/${logNo}`, { ua: UA_MOBILE })).text();
    const m = html.match(/id="_post_property"[\s\S]{0,400}?commentCount="(\d+)"/)
      || html.match(/\\"commentCount\\":(\d+)/);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

async function mapPool(items, n, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await worker(items[i], i); }
  }));
  return out;
}

const statRows = () => mapPool(posts, CONCURRENCY, async (p) => {
  const [views, likes, comments] = await Promise.all([viewsOf(p.logNo), likesOf(p.logNo), commentsOf(p.logNo)]);
  console.error(`  ${p.logNo}  views ${views ?? '—'} · likes ${likes} · comments ${comments}  ${(p.title || p.slug).slice(0, 26)}`);
  return { title: p.title || p.slug, date: p.date || '', category: p.category || '', views, likes, comments };
});

let rows = await statRows();
// 전 게시물 views가 null이면 개별 글 문제가 아니라 세션 쿠키 사망 신호다(소유자 통계
// API는 인증 필수). env 쿠키였다면 CDP에서 한 번 재캡처해 재시도 — 죽은 값만 거부하고
// 갓 캡처한 쿠키는 통과시킨다(linkedin stats-fast와 같은 계약).
if (rows.length && rows.every((r) => r.views == null) && src === 'env') {
  console.error('every post read no views → re-capturing the session cookie');
  const dead = cookie;
  try {
    ({ cookie, src } = await resolveCookie({
      key: 'NAVER_COOKIE', port: cdpPort(), chromium,
      origins: ['https://blog.naver.com', 'https://blog.stat.naver.com', 'https://naver.com'],
      names: COOKIE_NAMES,
      validate: async (c) => c !== dead,
    }));
    rows = await statRows();
  } catch (e) {
    console.error(`cookie re-capture failed: ${e.message}`);
  }
}

// markdown table (date desc)
console.log(`\nview-count basis date: ${viewDate} (Naver stats finalize daily; same-day figures reflect the next day)\n`);
console.log('| title | date | board | views | likes | comments |');
console.log('| --- | --- | --- | --: | --: | --: |');
let V = 0, L = 0, C = 0;
for (const r of rows) {
  L += r.likes; C += r.comments; V += (r.views || 0);
  console.log(`| ${r.title.slice(0, 30)} | ${r.date} | ${r.category} | ${r.views ?? '—'} | ${r.likes} | ${r.comments} |`);
}
console.log(`| **total (${rows.length})** | | | **${V}** | **${L}** | **${C}** |`);
console.error(`(cookie: ${src})`);
