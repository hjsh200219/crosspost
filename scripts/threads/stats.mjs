#!/usr/bin/env node
// Threads engagement stats — reads the published-threads.json ledger and queries the
// Graph API insights endpoint per root post. Tokens read from $CROSSPOST_HOME/.env.
//
//   node stats.mjs
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { loadEnv, dataPath } from '../lib/env.mjs';
import { publishMs } from '../lib/publish-order.mjs';

loadEnv();

const DIR = path.dirname(new URL(import.meta.url).pathname);
const LEDGER = dataPath('ledgers/published-threads.json');
const GRAPH = 'https://graph.threads.net/v1.0';
const METRICS = ['views', 'likes', 'replies', 'reposts', 'quotes'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOKEN = process.env.THREADS_ACCESS_TOKEN;
if (!TOKEN) { console.error('THREADS_ACCESS_TOKEN 가 .env에 없습니다.'); process.exit(1); }

async function insights(rootId) {
  const qs = new URLSearchParams({ metric: METRICS.join(','), access_token: TOKEN });
  const res = await fetch(`${GRAPH}/${rootId}/insights?${qs}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 160)}`);
  const out = {};
  for (const m of JSON.parse(text).data || []) {
    out[m.name] = m.total_value ? (m.total_value.value ?? 0) : (m.values?.[0]?.value ?? 0);
  }
  return out;
}

function titleOf(file) {
  try {
    const first = readFileSync(path.resolve(DIR, file), 'utf8').split('\n').map((l) => l.trim()).find(Boolean) || '';
    return first.length > 30 ? first.slice(0, 29) + '…' : (first || file);
  } catch { return file; }
}

// --limit N (default 20; 0 = 전체). 날짜 = 원본 LinkedIn 발행일(파일명 프리픽스),
// Threads 게재일(백필로 대부분 동일 날짜)이 아님 → 최근순 정렬이 채널 간 일치.
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? Math.max(0, parseInt(process.argv[i + 1], 10) || 0) : 20; })();
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || '5', 10));
const dateKey = (f) => (path.basename(f || '').match(/(\d{4}-\d{2}-\d{2})/) || [, ''])[1];

async function pool(items, n, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await worker(items[i], i); }
  }));
  return out;
}

const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : [];
if (!ledger.length) { console.log('장부가 비어 있습니다 (published-threads.json).'); process.exit(0); }

let entries = ledger.map((e) => ({ ...e, _date: dateKey(e.file) || e.date || '' }));
entries.sort((a, b) => publishMs(b) - publishMs(a));
if (LIMIT > 0) entries = entries.slice(0, LIMIT);

// 동시 호출 (Graph API insights) — 순차 250ms sleep 제거, 소량 stagger로 스로틀만 회피
const rows = await pool(entries, CONCURRENCY, async (e, i) => {
  const title = titleOf(e.file);
  await sleep((i % CONCURRENCY) * 120);
  try {
    const m = await insights(e.rootId);
    return { title, date: e._date, publishedAt: e.publishedAt, file: e.file, views: m.views ?? 0, likes: m.likes ?? 0, replies: m.replies ?? 0, reposts: m.reposts ?? 0 };
  } catch (err) {
    return { title, date: e._date, publishedAt: e.publishedAt, file: e.file, error: err.message.replace(/[|\n]/g, ' ').slice(0, 60) };
  }
});
rows.sort((a, b) => publishMs(b) - publishMs(a));

const HEAD = ['제목', '날짜', '조회수', '좋아요', '댓글', '리포스트'];
const lines = [`| ${HEAD.join(' | ')} |`, `| ${HEAD.map(() => '---').join(' | ')} |`];
let tv = 0, tl = 0, tr = 0, trp = 0;
for (const r of rows) {
  if (r.error) { lines.push(`| ${r.title} | ${r.date} | ERROR: ${r.error} | | | |`); continue; }
  tv += r.views; tl += r.likes; tr += r.replies; trp += r.reposts;
  lines.push(`| ${r.title} | ${r.date} | ${r.views} | ${r.likes} | ${r.replies} | ${r.reposts} |`);
}
lines.push(`| 합계 | | ${tv} | ${tl} | ${tr} | ${trp} |`);
console.log(lines.join('\n'));
