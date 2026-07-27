#!/usr/bin/env node
/**
 * Instagram stats — every post in $CROSSPOST_HOME/ledgers/published-instagram.json.
 *
 * Two layers, because they need different permissions:
 *   1. media node fields (like_count · comments_count · timestamp) — `instagram_basic` is enough
 *   2. insights (views · reach · saved · shares) — needs `instagram_manage_insights`
 *
 * If the token lacks the insights permission the columns read `—` and a hint is printed once,
 * rather than failing the whole report.
 *
 * env: IG_USER_ID, IG_ACCESS_TOKEN
 * usage: node stats.mjs [--json] [--limit N]
 */
import { readFileSync, existsSync } from 'node:fs';
import { loadEnv, dataPath } from '../lib/env.mjs';

loadEnv();

const GRAPH = 'https://graph.facebook.com/v21.0';
const LEDGER = dataPath('ledgers/published-instagram.json');
const IG = process.env.IG_USER_ID;
const TOKEN = process.env.IG_ACCESS_TOKEN;
if (!IG || !TOKEN) { console.error('missing IG_USER_ID / IG_ACCESS_TOKEN in $CROSSPOST_HOME/.env'); process.exit(1); }

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const limIdx = args.indexOf('--limit');
const LIMIT = limIdx !== -1 ? Number(args[limIdx + 1]) : 0;

const q = async (path, params) => {
  const u = new URL(`${GRAPH}${path}`);
  for (const [k, v] of Object.entries({ ...params, access_token: TOKEN })) u.searchParams.set(k, v);
  return (await fetch(u)).json();
};

const acct = await q(`/${IG}`, { fields: 'username,followers_count,media_count' });
if (acct.error) { console.error(JSON.stringify(acct.error)); process.exit(1); }

let ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : [];
if (!ledger.length) { console.log('ledger is empty (nothing published yet).'); process.exit(0); }
ledger = [...ledger].reverse();
if (LIMIT > 0) ledger = ledger.slice(0, LIMIT);

// Insights metrics. SUPPORT VARIES BY MEDIA TYPE and an unsupported metric fails the WHOLE
// request — there is no partial response. So only ask for what every type supports
// (`profile_visits`, for one, is rejected for carousels and reels).
const METRICS = ['views', 'reach', 'saved', 'shares', 'total_interactions'];
// Missing permission is a fact about the token, so latch it once. An unsupported metric is a
// fact about ONE post, so never latch that — treating it globally makes a single post's (#100)
// switch the column off for every other row and report the wrong reason for it.
const isPermissionError = (e) => e.code === 10 || e.code === 200 || /permission/i.test(e.message || '');
let insightsOk = null;
let permissionNote = null;

const rows = [];
for (const e of ledger) {
  // media_product_type is what distinguishes a reel from a feed post — media_type reports
  // plain `VIDEO` for reels too.
  const m = await q(`/${e.id}`, { fields: 'id,permalink,media_type,media_product_type,timestamp,like_count,comments_count' });
  if (m.error) { rows.push({ slug: e.slug, format: e.format || 'carousel', error: m.error.message }); continue; }

  let ins = {};
  if (insightsOk !== false) {
    const r = await q(`/${e.id}/insights`, { metric: METRICS.join(',') });
    if (r.error) {
      if (isPermissionError(r.error)) { insightsOk = false; permissionNote = r.error.message; }
      // else: this media type doesn't support one of the metrics — leave this row blank only
    } else {
      insightsOk = true;
      for (const d of r.data || []) ins[d.name] = d.values?.[0]?.value ?? null;
    }
  }

  rows.push({
    slug: e.slug,
    format: e.format || (m.media_product_type === 'REELS' ? 'reels' : 'carousel'),
    date: (m.timestamp || '').slice(0, 10),
    permalink: m.permalink,
    views: ins.views ?? null,
    reach: ins.reach ?? null,
    saved: ins.saved ?? null,
    shares: ins.shares ?? null,
    likes: m.like_count ?? 0,
    comments: m.comments_count ?? 0,
  });
}

if (asJson) {
  console.log(JSON.stringify({ account: acct, rows }, null, 2));
  process.exit(0);
}

console.log(`\nInstagram @${acct.username} — ${acct.followers_count} followers · ${acct.media_count} posts\n`);
console.log('| post | date | format | views | reach | saved | shares | likes | comments |');
console.log('| --- | --- | --- | --: | --: | --: | --: | --: | --: |');
const T = { views: 0, reach: 0, saved: 0, shares: 0, likes: 0, comments: 0 };
for (const r of rows) {
  // a deleted post still sits in the ledger — show it as failed rather than as zeros
  if (r.error) { console.log(`| ${r.slug} | — | ${r.format} | — | — | — | — | — | — |  <!-- ${r.error.slice(0, 60)} -->`); continue; }
  for (const k of Object.keys(T)) T[k] += r[k] || 0;
  const c = (v) => (v == null ? '—' : v);
  console.log(`| ${r.slug.slice(0, 30)} | ${r.date} | ${r.format} | ${c(r.views)} | ${c(r.reach)} | ${c(r.saved)} | ${c(r.shares)} | ${r.likes} | ${r.comments} |`);
}
console.log(`| **total (${rows.length})** | | | **${T.views}** | **${T.reach}** | **${T.saved}** | **${T.shares}** | **${T.likes}** | **${T.comments}** |`);

if (insightsOk === false) {
  console.error(`\nInsights columns are blank: the token lacks instagram_manage_insights (${permissionNote}).`);
  console.error('Add that permission to the app and re-consent — re-authorizing without editing the');
  console.error('permission set re-applies the OLD scopes, which looks like it worked and changes nothing.');
}
// Carousels and reels reach people differently (reels surface to non-followers, carousels
// convert followers), so a combined total hides the thing worth knowing — hence the format column.
