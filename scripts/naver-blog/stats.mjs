// Naver blog per-post stats (조회) for ledger posts, via the logged-in CDP profile.
//   node stats.mjs                 # all ledger posts (views = yesterday, last finalized day)
//   node stats.mjs <logNo>         # one post
//   node stats.mjs --date 2026-07-13   # views for a specific finalized date
//
// Metrics: 조회수(views) from the owner 통계 dashboard ranking API (rank/cvContentPc,
// same source as admin > 통계 > 조회수 순위), 공감(likes) via the blogserver like API,
// 댓글(comments) via cbox JSONP. Naver finalizes view stats DAILY with a lag — a post
// published today shows views starting from the next day's finalized data.
import { existsSync, readFileSync } from 'fs';
import { connect, acquirePage, releasePage } from './cdp.mjs';
import { loadEnv, dataPath } from '../lib/env.mjs';
import { publishMs } from '../lib/publish-order.mjs';

loadEnv();

// Per-post views from the owner 통계 API (blog.stat.naver.com/api/blog/article/cv,
// contentId=logNo) — the same source as 관리 > 통계 > 게시물 조회수. Same-origin only, so
// we load a blog.stat page first, then in-page fetch the cv series per post and sum the
// daily cv over the returned window. Naver finalizes views DAILY (same-day is delayed).
async function fetchViews(ctx, logNos, endDate) {
  const p = await acquirePage(ctx);
  const map = {};
  try {
    if (!logNos.length) return map;
    await p.goto(`https://blog.stat.naver.com/blog/article/${logNos[0]}/cv`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await p.waitForTimeout(2000);
    for (const logNo of logNos) {
      const v = await p.evaluate(async ({ logNo, endDate }) => {
        try {
          const r = await fetch(`https://blog.stat.naver.com/api/blog/article/cv?timeDimension=DATE&startDate=${endDate}&contentId=${logNo}`, { credentials: 'include' });
          const j = await r.json();
          const cv = j?.result?.statDataList?.[0]?.data?.rows?.cv;
          return Array.isArray(cv) ? cv.reduce((s, x) => s + (x || 0), 0) : null;
        } catch { return null; }
      }, { logNo, endDate });
      map[logNo] = v;
    }
  } catch {} finally { await releasePage(p); }
  return map;
}

const LEDGER = dataPath('ledgers/published-naver.json');
const BLOG_ID = process.env.NAVER_BLOG_ID;
if (!BLOG_ID) { console.error('NAVER_BLOG_ID not set in $CROSSPOST_HOME/.env'); process.exit(1); }
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

const { browser, ctx } = await connect();
const views = await fetchViews(ctx, posts.map((p) => p.logNo), viewDate); // { logNo: views }
const page = await acquirePage(ctx);
const rows = [];
try {
  // Load a page on the blog origin so credentialed fetches / JSONP work.
  await page.goto(`https://blog.naver.com/${BLOG_ID}/${posts[0].logNo}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

  for (const p of posts) {
    const m = await page.evaluate(async ({ blogId, logNo }) => {
      // likes: blogserver like API (credentialed) → sum reaction counts
      let likes = 0;
      try {
        const r = await fetch(`https://apis.naver.com/blogserver/like/v1/search/contents?suppress_response_codes=true&q=BLOG%5B${blogId}_${logNo}%5D&pool=blogid`, { credentials: 'include' });
        const j = await r.json();
        const c = j?.contents?.[0];
        if (c?.reactions?.length) likes = c.reactions.reduce((s, x) => s + (x.count || 0), 0);
        else if (typeof c?.likeItCount === 'number') likes = c.likeItCount;
      } catch {}
      // comments: cbox count via JSONP (fetch is CORS-blocked; script injection works)
      const comments = await new Promise((resolve) => {
        const cb = `__cbox_${Date.now()}`;
        window[cb] = (d) => { try { resolve(d?.result?.count?.comment ?? d?.result?.count?.total ?? 0); } catch { resolve(0); } delete window[cb]; s.remove(); };
        const s = document.createElement('script');
        s.src = `https://apis.naver.com/commentBox/cbox/web_naver_list_jsonp.json?ticket=blog&pool=cbox5&_cv=&lang=ko&country=KR&objectId=${blogId}_${logNo}&pageSize=1&page=1&sort=NEW&_callback=${cb}`;
        s.onerror = () => { resolve(0); delete window[cb]; s.remove(); };
        document.body.appendChild(s);
        setTimeout(() => { if (window[cb]) { resolve(0); delete window[cb]; try { s.remove(); } catch {} } }, 4000);
      });
      return { likes, comments };
    }, { blogId: BLOG_ID, logNo: p.logNo });
    const v = views[p.logNo];
    rows.push({ title: p.title || p.slug, date: p.date || '', category: p.category || '', views: v, likes: m.likes, comments: m.comments });
    console.log(`  ${p.logNo}  views ${v ?? '—'} · likes ${m.likes} · comments ${m.comments}  ${(p.title || p.slug).slice(0, 26)}`);
  }
} finally { await releasePage(page); await browser.close().catch(() => {}); }

// markdown table (date desc)
console.log(`\nview-count basis date: ${viewDate} (Naver stats finalize daily; same-day figures reflect the next day)\n`);
console.log('| title | date | board | views | likes | comments |');
console.log('| --- | --- | --- | --: | --: | --: |');
let V = 0, L = 0, C = 0;
for (const r of rows) {
  L += r.likes; C += r.comments; V += (r.views || 0);
  console.log(`| ${r.title.slice(0, 30)} | ${r.date} | ${r.category} | ${r.views ?? '—'} | ${r.likes} | ${r.comments} |`);
}
console.log(`| **Total (${rows.length})** | | | **${V}** | **${L}** | **${C}** |`);
