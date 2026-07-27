#!/usr/bin/env node
// Engagement stats for published posts — the single reliable stats engine.
//
// Per URN it loads that post's OWN analytics page (/analytics/post-summary/<activityUrn>/)
// and reads native impressions there. Because every URN has its own URL, there is no way to
// read another post's numbers — this is structurally immune to the cross-card contamination
// that the old feed-update scrape (stats.mjs, now a forwarding shim) suffered: that one
// grabbed the FIRST .feed-shared-update-v2 on /feed/update/<urn>/, but SPA re-navigation
// could leave a prior post's card or render a suggested card first, so impressions drifted
// vs the title and duplicated across runs (totals 1123/830/977 disagreed, 2026-06-28).
//
// LinkedIn standard-tier tokens are write-only (socialActions GET = 403) and counts moved
// behind rotating graphql queryIds, so the analytics page is the only reliable source — but
// it does NOT need a browser: the page is server-rendered, and a plain cookie'd fetch gets the
// numbers (2026-07-27, 10 posts in 1.5s vs ~48s over CDP). The RSC flight payload embedded in
// that HTML lists the rendered text nodes IN ORDER, so the same metricFromLines() parser reads
// both paths. CDP is now only needed for --all (infinite-scroll discovery) and for re-capturing
// the session cookie when the stored one expires.
//
//   node stats-fast.mjs                  # all posts in published-linkedin.json (ledger)
//   node stats-fast.mjs <urn> [...]      # specific share/activity urns
//   node stats-fast.mjs --all [scrolls]  # discover posts from the profile activity feed
//                                        #   (incl. ones not in the ledger) then stat each
//                                        #   via its analytics page (reliable, not feed-card)
//   node stats-fast.mjs --account hj     # another authorized account (CDP port/ledger/vanity per account.mjs)
//   CONCURRENCY=4 node stats-fast.mjs    # parallel page count (default 2)
//   FORMAT=json node stats-fast.mjs      # machine-readable
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { publishMs } from '../lib/publish-order.mjs';
import { resolveCookie } from '../lib/site-cookie.mjs';
import { parseAccount, accountFile, cdpPort, vanity, label, suffix } from './account.mjs';

const { account, rest: ARGV } = parseAccount(process.argv.slice(2));
// --limit N (default 20; 0 = the whole ledger). Ignored when explicit urn args are given. Flag stripped from ARGV.
let LIMIT = 20;
{ const i = ARGV.indexOf('--limit'); if (i >= 0) { LIMIT = Math.max(0, parseInt(ARGV[i + 1], 10) || 0); ARGV.splice(i, 2); } }
const PORT = cdpPort(account);
const VANITY = vanity(account);
const LEDGER = accountFile('published-linkedin.json', account);
const HISTORY = accountFile('stats-history-linkedin.jsonl', account); // shared with delta continuity
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || '8', 10));
const RETRIES = Math.max(0, parseInt(process.env.RETRIES || '2', 10));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lastSnapshot() {
  if (!existsSync(HISTORY)) return null;
  const lines = readFileSync(HISTORY, 'utf8').trim().split('\n').filter(Boolean);
  if (!lines.length) return null;
  try { return JSON.parse(lines[lines.length - 1]); } catch { return null; }
}

function saveSnapshot(results) {
  const slim = results
    .filter((r) => !r.error)
    .map(({ urn, title, impressions, reactions, comments, reposts }) => ({ urn, title, impressions, reactions, comments, reposts }));
  if (slim.length) appendFileSync(HISTORY, JSON.stringify({ ts: new Date().toISOString(), results: slim }) + '\n');
}

function titleOf(entry) {
  try {
    if (entry.file && entry.file !== '-' && existsSync(entry.file)) {
      const first = readFileSync(entry.file, 'utf8').trim().split('\n')[0].trim();
      if (first) return first.slice(0, 60);
    }
  } catch {}
  return entry.head || null; // --all discovery supplies head text as a title fallback
}

function delta(cur, prev) {
  if (cur == null || prev == null) return '';
  const d = cur - prev;
  return d === 0 ? '' : d > 0 ? ` (+${d})` : ` (${d})`;
}

// post-summary has TWO layouts: Discovery metrics are "<value>\n\n<Label>" (value
// before label), the Engagement breakdown is "<Label>\n\n<value>" (value after).
// So scan the correct direction per label, skipping blank lines.
//   dir 'before' → impressions ; dir 'after' → reactions/comments/reposts
function metricFromLines(lines, label, dir) {
  const isNum = (s) => /^\d[\d,]*$/.test((s || '').replace(/\s/g, ''));
  const toNum = (s) => parseInt(s.replace(/[,\s]/g, ''), 10);
  const step = dir === 'before' ? -1 : 1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() !== label) continue;
    for (let j = i + step, n = 0; j >= 0 && j < lines.length && n < 3; j += step) {
      if (!lines[j].trim()) continue; // skip blanks
      n++;
      if (isNum(lines[j])) return toNum(lines[j]);
      break; // first non-blank neighbour wasn't a number → no value here, try next label match
    }
  }
  return null;
}

// ── browserless path (default) ─────────────────────────────────────────────────────────
// The analytics page is server-rendered and its RSC flight payload carries every rendered
// text node as {"children":["<text>"]} IN VISUAL ORDER — i.e. the same line sequence the CDP
// path read out of document.body.innerText. So metricFromLines() is reused verbatim and the
// two paths cannot drift apart in how they interpret a label.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const COOKIE_KEY = 'LINKEDIN_COOKIE' + suffix(account);
// li_at alone. Sending the whole profile cookie jar makes LinkedIn answer 400 with an empty
// body (measured 2026-07-27) — this list is correctness, not thrift.
const COOKIE_NAMES = ['li_at'];

function rscLines(html) {
  for (const re of [/children\\":\[\\"((?:[^"\\]|\\.){1,120}?)\\"\]/g, /"children":\["((?:[^"\\]|\\.){1,120}?)"\]/g]) {
    const out = [...html.matchAll(re)].map((m) => m[1].replace(/\\u003c/g, '<').replace(/\\"/g, '"'));
    if (out.length > 5) return out;
  }
  return [];
}

async function fetchText(url, cookie) {
  const r = await fetch(url, {
    headers: { cookie, 'user-agent': UA, accept: 'text/html,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function statsForHttp(cookie, entry) {
  let activityUrn = entry.activityUrn?.startsWith('urn:li:activity:') ? entry.activityUrn
    : entry.urn.startsWith('urn:li:activity:') ? entry.urn : null;
  if (!activityUrn) {
    // the share permalink resolves to the backing activity urn (a deleted post renders a
    // "Post not found" shell with no activity urn — that surfaces as a hard error, as before)
    const html = await fetchText(`https://www.linkedin.com/feed/update/${entry.urn}/`, cookie);
    activityUrn = (html.match(/urn:li:activity:\d+/) || [])[0];
  }
  if (!activityUrn) throw new Error('failed to resolve activity urn');

  const lines = rscLines(await fetchText(`https://www.linkedin.com/analytics/post-summary/${activityUrn}/`, cookie));
  return {
    activityUrn,
    impressions: metricFromLines(lines, 'impressions', 'before'),
    reactions: metricFromLines(lines, 'reactions', 'after') ?? 0,
    comments: metricFromLines(lines, 'comments', 'after') ?? 0,
    reposts: metricFromLines(lines, 'reposts', 'after') ?? 0,
  };
}

// concurrency pool over plain async tasks (HTTP path — no pages to hand out)
async function mapPool(items, n, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await worker(items[i], i);
      }
    }),
  );
  return out;
}

// Resolve the backing activity urn for a share urn (post-summary needs the activity
// urn — a share urn renders an EMPTY analytics shell, not server-resolved). The
// feed-update page renders the post with its activity data-urn attribute; read that.
async function resolveActivityUrn(page, entry) {
  if (entry.activityUrn && entry.activityUrn.startsWith('urn:li:activity:')) return entry.activityUrn;
  const urn = entry.urn;
  if (urn.startsWith('urn:li:activity:')) return urn;

  try {
    await page.goto(`https://www.linkedin.com/feed/update/${urn}/`, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForFunction(
      () => !!document.querySelector('[data-urn^="urn:li:activity:"]'),
      { timeout: 8000 },
    ).catch(() => {});
    const durn = await page.evaluate(() => {
      const el = document.querySelector('[data-urn^="urn:li:activity:"]');
      return el ? el.getAttribute('data-urn') : null;
    });
    if (durn) return durn;
    // Fallback: fresh posts (published minutes/hours ago) sometimes don't render the
    // [data-urn] element yet, but the backing activity urn IS in the page HTML and its
    // analytics page already has data. /feed/update/<share>/ is that post's permalink,
    // so the first activity urn in the source is this post's. Without this fallback a
    // brand-new post reads as "failed to resolve activity urn" even though impressions exist.
    const html = await page.content();
    const m = html.match(/urn:li:activity:\d+/);
    if (m) return m[0];
  } catch {}
  return null;
}

async function statsFor(page, entry) {
  const activityUrn = await resolveActivityUrn(page, entry);
  if (!activityUrn) throw new Error('failed to resolve activity urn');

  await page.goto(`https://www.linkedin.com/analytics/post-summary/${activityUrn}/`, {
    waitUntil: 'domcontentloaded', timeout: 35000,
  });
  // wait for the metric VALUE (not just the label skeleton) to populate —
  // the "Impressions" label renders before its number loads.
  await page.waitForFunction(
    () => /\d[\d,]*\s+(Impressions|노출)/.test(document.body.innerText),
    { timeout: 9000 },
  ).catch(() => {});
  const body = await page.evaluate(() => document.body.innerText);
  const lines = body.split('\n');

  return {
    activityUrn,
    impressions: metricFromLines(lines, 'impressions', 'before'),
    reactions: metricFromLines(lines, 'reactions', 'after') ?? 0,
    comments: metricFromLines(lines, 'comments', 'after') ?? 0,
    reposts: metricFromLines(lines, 'reposts', 'after') ?? 0,
  };
}

// Discover posts from the profile activity feed (incl. ones not in the ledger).
// The feed is infinite-scroll lazy-load: a one-shot scrape only sees the initial ~5
// cards, so accumulate per scroll (byUrn Map) and stop after 2 no-growth rounds.
// We only collect URNs here; the numbers come from each post's analytics page (statsFor).
async function discoverAll(page, maxScrolls) {
  await page.goto(`https://www.linkedin.com/in/${VANITY}/recent-activity/all/`, {
    waitUntil: 'domcontentloaded', timeout: 45000,
  });
  await page.waitForTimeout(3500);
  const scrape = () =>
    page.evaluate(() => {
      const items = [];
      for (const el of document.querySelectorAll('[data-urn^="urn:li:activity:"], .feed-shared-update-v2')) {
        const urn = el.getAttribute('data-urn') || el.closest('[data-urn]')?.getAttribute('data-urn');
        if (!urn || !urn.startsWith('urn:li:activity:')) continue;
        const bodyEl = el.querySelector('.update-components-text, .feed-shared-inline-show-more-text');
        const head = (bodyEl?.innerText || '').trim().split('\n')[0].slice(0, 60);
        items.push({ urn, head });
      }
      return { items, docH: document.body.scrollHeight };
    });
  const byUrn = new Map();
  let stagnant = 0;
  for (let i = 0; i < maxScrolls; i++) {
    const { items, docH } = await scrape();
    for (const it of items) if (!byUrn.has(it.urn)) byUrn.set(it.urn, it);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    let grew = true;
    try {
      await page.waitForFunction((h) => document.body.scrollHeight > h, docH, { timeout: 4500 });
    } catch {
      grew = false;
    }
    if (!grew) {
      if (++stagnant >= 2) break;
    } else stagnant = 0;
  }
  const { items } = await scrape();
  for (const it of items) if (!byUrn.has(it.urn)) byUrn.set(it.urn, it);
  return [...byUrn.values()];
}

// simple concurrency pool over independent pages
async function runPool(pages, items, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    pages.map(async (page) => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await worker(page, items[i], i);
      }
    }),
  );
  return out;
}

const allMode = ARGV[0] === '--all';
if (allMode && !VANITY) {
  console.error(`--all requires LINKEDIN_VANITY (or LINKEDIN_VANITY_${label(account).toUpperCase()}) to be set in .env — no default profile slug.`);
  process.exit(1);
}
const argUrns = allMode ? [] : ARGV;
const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : [];
if (!allMode && !argUrns.length && !ledger.length) {
  console.log('No LinkedIn posts yet (published-linkedin.json is empty)');
  process.exit(0);
}

// Ledger-only targets need no browser at all — only --all does (infinite-scroll discovery).
function ledgerTargets() {
  if (argUrns.length) {
    return ledger.filter((e) => argUrns.includes(e.urn))
      .concat(argUrns.filter((u) => !ledger.some((e) => e.urn === u)).map((u) => ({ urn: u, file: '-', date: '-' })));
  }
  // Default: sort by publish date descending, keep only the most recent LIMIT (fewer
  // concurrent lookups = faster)
  const sorted = [...ledger].sort((a, b) => publishMs(b) - publishMs(a));
  return LIMIT > 0 ? sorted.slice(0, LIMIT) : sorted;
}

let targets;
let results;

if (!allMode) {
  targets = ledgerTargets();
  let { cookie, src } = await resolveCookie({
    key: COOKIE_KEY, port: PORT, chromium,
    origins: ['https://www.linkedin.com'], names: COOKIE_NAMES,
  });

  const run = async (ck) => mapPool(targets, CONCURRENCY, async (entry) => {
    let lastErr;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        const s = await statsForHttp(ck, entry);
        if (s.impressions == null) throw new Error('metrics not loaded');
        return { ...entry, title: titleOf(entry), ...s };
      } catch (e) {
        lastErr = e;
        if (attempt < RETRIES) await sleep(800 * (attempt + 1));
      }
    }
    return { ...entry, title: titleOf(entry), error: (lastErr?.message || 'unknown').slice(0, 80) };
  });

  results = await run(cookie);
  // Every target failing means the session cookie died, not that every post broke — re-capture
  // from the browser once and retry. Partial failures are real per-post errors; leave them.
  if (results.length && results.every((r) => r.error) && src === 'env') {
    console.error('every post failed → re-capturing the session cookie');
    try {
      ({ cookie, src } = await resolveCookie({
        key: COOKIE_KEY, port: PORT, chromium,
        origins: ['https://www.linkedin.com'], names: COOKIE_NAMES,
        validate: async () => false, // force a fresh CDP capture, ignore the stored value
      }));
      results = await run(cookie);
    } catch (e) {
      console.error(`cookie re-capture failed: ${e.message}`);
    }
  }
  console.error(`(cookie: ${src})`);
} else {

let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { noDefaults: true });
} catch {
  console.error(
    `CDP :${PORT} connection failed — --all discovery needs a logged-in browser (${label(account)}).\n` +
      '  1) npm run browser   (log in once, the session persists for weeks)\n' +
      '  2) re-run node stats-fast.mjs --all',
  );
  process.exit(2);
}

const ctx = browser.contexts()[0];

// --all needs the activity feed discovered first (single page), THEN stats each in parallel.
  const scrolls = parseInt(ARGV[1] || '25', 10); // adaptive: stops on 2 no-growth rounds
  const page0 = ctx.pages().find((p) => p.url().includes('linkedin.com')) || ctx.pages()[0] || (await ctx.newPage());
  const found = await discoverAll(page0, scrolls);
  // prefer ledger metadata (title/date) when a discovered activity urn matches a known post
  const ledgerByActivity = new Map(ledger.filter((e) => e.activityUrn).map((e) => [e.activityUrn, e]));
  targets = found.map((f) => {
    const known = ledgerByActivity.get(f.urn);
    return known ? { ...known } : { urn: f.urn, file: '-', date: '', head: f.head };
  });

const pool = [page0];
while (pool.length < Math.min(CONCURRENCY, targets.length)) pool.push(await ctx.newPage());

results = await runPool(pool, targets, async (page, entry, i) => {
  await sleep((i % CONCURRENCY) * 400); // stagger initial burst to dodge throttling
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const s = await statsFor(page, entry);
      if (s.impressions == null) throw new Error('metrics not loaded'); // treat empty render as retryable
      return { ...entry, title: titleOf(entry), ...s };
    } catch (e) {
      lastErr = e;
      if (attempt < RETRIES) await sleep(1200 * (attempt + 1)); // backoff (throttle needs seconds)
    }
  }
  return { ...entry, title: titleOf(entry), error: (lastErr?.message || 'unknown').slice(0, 80) };
});

// release any extra pages we opened (keep the first for session reuse)
for (const p of pool.slice(1)) await p.close().catch(() => {});
await browser.close();

}

// persist newly resolved activity urns back into the ledger (one-time backfill)
let ledgerDirty = false;
for (const r of results) {
  if (r.error || !r.activityUrn) continue;
  const e = ledger.find((x) => x.urn === r.urn);
  if (e && !e.activityUrn) { e.activityUrn = r.activityUrn; ledgerDirty = true; }
}
if (ledgerDirty) writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n');

const prev = lastSnapshot();
const prevByUrn = new Map((prev?.results || []).map((r) => [r.urn, r]));

if (process.env.FORMAT === 'json') {
  console.log(JSON.stringify(results, null, 2));
} else {
  if (prev) console.log(`(previous check: ${prev.ts})`);
  let tImp = 0, tReact = 0, tComm = 0, tRep = 0, ok = 0;
  for (const r of results) {
    const name = r.title || (r.file || r.urn).replace(/^posts\//, '').replace(/\.txt$/, '');
    if (r.error) { console.log(`${r.date}  ${name}\n  ERROR: ${r.error}`); continue; }
    const p = prevByUrn.get(r.urn);
    const imp = r.impressions == null ? '-' : r.impressions;
    console.log(
      `${r.date}  ${name}\n  impressions ${imp}${delta(r.impressions, p?.impressions)}` +
        ` · reactions ${r.reactions}${delta(r.reactions, p?.reactions)}` +
        ` · comments ${r.comments}${delta(r.comments, p?.comments)}` +
        ` · reposts ${r.reposts}${delta(r.reposts, p?.reposts)}`,
    );
    ok++; tImp += r.impressions || 0; tReact += r.reactions || 0; tComm += r.comments || 0; tRep += r.reposts || 0;
  }
  console.log(`\nTotal ${ok} posts · impressions ${tImp} · reactions ${tReact} · comments ${tComm} · reposts ${tRep}`);
}
saveSnapshot(results);
