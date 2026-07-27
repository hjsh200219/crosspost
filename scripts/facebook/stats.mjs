#!/usr/bin/env node
// Read engagement + reach stats for Facebook Page posts.
// Reads FACEBOOK_PAGE_ACCESS_TOKEN from $CROSSPOST_HOME/.env and the
// published-facebook.json ledger. Prints a fixed table: title | date | reach | likes | comments | shares.
//   node stats.mjs                # posts in ledger
//   node stats.mjs <post-id> ...  # specific posts
import { readFileSync, existsSync } from 'fs';
import { loadEnv, dataPath } from '../lib/env.mjs';
import { publishMs } from '../lib/publish-order.mjs';

loadEnv();

const LEDGER = dataPath('ledgers/published-facebook.json');
const GRAPH = 'https://graph.facebook.com/v21.0';

const TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
if (!TOKEN) { console.error('missing FACEBOOK_PAGE_ACCESS_TOKEN in $CROSSPOST_HOME/.env — run get-page-token.mjs first'); process.exit(1); }

const args = process.argv.slice(2);
const limIdx = args.indexOf('--limit');
const limitArg = limIdx >= 0 ? Number(args[limIdx + 1]) : 20; // default recent 20 (match other channels + fb-reach); --limit 0 = all
const CONCURRENCY = Math.max(1, Number(process.env.FB_CONCURRENCY || 8));
const led = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : [];
const ledArr = Array.isArray(led) ? led : Object.values(led);
const dateKey = (f) => (String(f || '').match(/(\d{4}-\d{2}-\d{2})/) || [, ''])[1];
const dateById = new Map(ledArr.map((e) => [e.id, dateKey(e.file) || e.date]).filter(([id]) => id));
// Sort by this channel's own publish timestamp; legacy rows fall back to their date.
const msById = new Map(ledArr.map((e) => [e.id, publishMs({ publishedAt: e.publishedAt, date: dateKey(e.file) || e.date })]).filter(([id]) => id));
// explicit positional ids (exclude the --limit value); else ledger ids, date desc, sliced to limit
const limValIdx = limIdx >= 0 ? limIdx + 1 : -1;
const explicit = args.filter((a, i) => !a.startsWith('--') && i !== limValIdx);
let ids;
if (explicit.length) {
  ids = explicit;
} else {
  ids = ledArr.filter((e) => e && e.id)
    .map((e) => ({ id: e.id }))
    .sort((a, b) => (msById.get(b.id) ?? 0) - (msById.get(a.id) ?? 0))
    .map((e) => e.id);
  if (limitArg > 0) ids = ids.slice(0, limitArg);
}
if (!ids.length) { console.error('no posts (empty ledger, or pass ids)'); process.exit(0); }

// Graph 오류 응답(400 + {error:{...}})이나 JSON 아닌 응답(HTML 오류 페이지)을
// 0점짜리 정상 행으로 위장하지 않도록 error 객체로 표면화한다.
const j = async (url) => {
  const r = await fetch(url);
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { error: { message: `HTTP ${r.status}: ${text.slice(0, 80)}` } }; }
};
const firstLine = (m) => (m || '').split('\n')[0].replace(/^"|"$/g, '').slice(0, 30);

async function stat(id) {
  const base = await j(
    `${GRAPH}/${id}?fields=created_time,message,` +
      `reactions.summary(total_count).limit(0),` +
      `comments.summary(total_count).limit(0),shares&access_token=${encodeURIComponent(TOKEN)}`,
  );
  if (base.error) return { id, date: dateById.get(id) || '', error: base.error };
  return {
    id,
    title: firstLine(base.message),
    date: dateById.get(id) || (base.created_time || '').slice(0, 10),
    impressions: null, // post_impressions insights metric dropped (#100 all versions v18~v23) → reach comes from fb-reach.mjs instead
    reactions: base.reactions?.summary?.total_count ?? 0,
    comments: base.comments?.summary?.total_count ?? 0,
    shares: base.shares?.count ?? 0,
  };
}

// concurrent pool — Graph calls are independent per post
const rows = new Array(ids.length);
let idx = 0;
const worker = async () => { for (let i = idx++; i < ids.length; i = idx++) rows[i] = await stat(ids[i]); };
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
rows.sort((a, b) => (msById.get(b.id) ?? 0) - (msById.get(a.id) ?? 0));

// 토큰이 죽으면(OAuthException 190) 모든 행이 쓰레기다 — 0으로 채운 표 대신 크게 실패한다.
const tokenErr = rows.find((r) => r.error?.code === 190);
if (tokenErr) {
  console.error(`Facebook token invalid (error 190): ${tokenErr.error.message} — re-run get-page-token.mjs`);
  process.exit(1);
}

console.log('| title | date | reach | likes | comments | shares |');
console.log('| --- | --- | --: | --: | --: | --: |');
let ti = 0, tr = 0, tc = 0, ts = 0;
for (const r of rows) {
  if (r.error) {
    // 삭제된 게시물 등 — 0점 행으로 위장하지 않고 실패 행으로 보여주며 합계에서 제외
    console.log(`| ${r.id} | ${r.date} | — | — | — | — |`);
    console.error(`  ! ${r.id}: ${String(r.error.message || '').slice(0, 80)}`);
    continue;
  }
  ti += r.impressions || 0; tr += r.reactions; tc += r.comments; ts += r.shares;
  console.log(`| ${r.title} | ${r.date} | ${r.impressions ?? '—'} | ${r.reactions} | ${r.comments} | ${r.shares} |`);
}
console.log(`| **total** | | **${ti}** | **${tr}** | **${tc}** | **${ts}** |`);
