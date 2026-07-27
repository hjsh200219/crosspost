#!/usr/bin/env node
// Remember 커넥트 post stats (뷰/좋아요/댓글) for your own posts.
//
// 정본 경로 = 공식 내부 API `v1/posts/list_by_author` (정확한 view_count 반환).
// 과거 DOM 스크랩은 피드 카드가 "뷰 N" 토큰을 렌더하지 않으면 0으로 잘못 집계했음
// (좋아요는 있는데 뷰=0인 모순). 이제 로그인된 Chromium(CDP)에서 앱이 쏘는
// 요청의 Authorization 토큰만 가로채고, API를 직접 페이지네이션해 실값을 가져온다.
//
// Usage:
//   node remember-stats.mjs            # 장부(published-remember.jsonl)의 전 포스트
//
// Output: JSON lines {title, date, views, likes, comments, shares, matched} + 요약 표.
// shares는 API에 카운트 필드가 없어 항상 null. 날짜는 리멤버 게시 created_at 기준.
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { getToken } from './token.mjs';
import { loadEnv, home, dataPath, cdpPort } from '../lib/env.mjs';

loadEnv();

const PORT = cdpPort();
const ENV_PATH = path.join(home(), '.env');
const LEDGER = dataPath('ledgers/published-remember.jsonl');
const API = 'https://connect-api.rememberapp.co.kr/v1/posts/list_by_author';
// REMEMBER_PROFILE_ID = your Remember `open_profile_id` (found in a logged-in
// network request to list_by_author). No personal default — required.
const PROFILE_ID = parseInt(process.env.REMEMBER_PROFILE_ID || '', 10);
if (!Number.isFinite(PROFILE_ID)) {
  console.error('REMEMBER_PROFILE_ID is not set — add it to .env (see config/.env.example).');
  process.exit(2);
}
// --limit N (default 20; 0 = 전체). 전 페이지는 매칭 위해 fetch, 출력만 최근 N개로 자름.
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? Math.max(0, parseInt(process.argv[i + 1], 10) || 0) : 20; })();

// 우리 글 목록: 장부 각 항목의 본문 첫 줄(title)
function ledgerPosts() {
  if (!existsSync(LEDGER)) return [];
  const out = [];
  const seen = new Set(); // 장부 중복 게시(같은 글 재게시) 제거 — basename 기준
  let bad = 0; // 읽기 전용 리포트라 중단하진 않지만, 조용히 행이 빠지면 안 된다
  for (const l of readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean)) {
    try {
      const { file, ts } = JSON.parse(l);
      const base = path.basename(file);
      if (seen.has(base)) continue;
      seen.add(base);
      const fp = path.isAbsolute(file) ? file : path.resolve(file);
      const title = existsSync(fp) ? readFileSync(fp, 'utf8').split('\n')[0].trim() : base;
      out.push({ file, ts, title });
    } catch { bad++; }
  }
  if (bad) console.error(`warning: ${bad} unparseable ledger line(s) skipped — check ${LEDGER}`);
  return out;
}

// 토큰 = env REMEMBER_TOKEN(browserless) → 없으면 CDP에서 remember_session 쿠키 읽기
// (token.mjs, post와 공유). 과거의 feed 렌더 + list_by_author 요청 가로채기 폐기.
const profileId = PROFILE_ID;
let authHdr;
try { const a = await getToken({ envPath: ENV_PATH, port: PORT }); authHdr = a.hdr; if (a.src === 'env') console.error('token src: env (browserless)'); }
catch (e) {
  console.error(`token acquisition failed — ${e.message} (set env REMEMBER_TOKEN or run npm run browser to log in)`);
  process.exit(2);
}

const hdr = {
  'Content-Type': 'application/json',
  Authorization: authHdr,
  Origin: 'https://connect.rememberapp.co.kr',
  Referer: 'https://connect.rememberapp.co.kr/',
};

// 전 페이지 수집 (순수 node fetch — 브라우저 불필요)
const posts = [];
let pg = 1, totalPages = 1;
do {
  const r = await fetch(`${API}?page=${pg}&per=20`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ author_type: 'USER', open_profile_id: profileId }),
  });
  if (r.status !== 200) {
    console.error(`API ${r.status} on page ${pg}: ${(await r.text()).slice(0, 160)}`);
    process.exit(3);
  }
  const j = await r.json();
  totalPages = j.meta?.total_pages || 1;
  for (const p of j.data || []) {
    posts.push({
      content: p.content || '',
      created: (p.created_at || '').slice(0, 10),
      views: p.post_stats?.view_count ?? 0,
      likes: p.post_stats?.reaction_count ?? 0,
      comments: p.post_stats?.comment_count ?? 0,
    });
  }
  pg++;
} while (pg <= totalPages);

// 장부 글 ↔ API 글 매칭 (본문 첫 ~16자 substring)
const mine = ledgerPosts();
const rows = [];
for (const m of mine) {
  const key = m.title.replace(/^["']|["']$/g, '').slice(0, 16);
  const hit = posts.find((p) => p.content.includes(key));
  rows.push({
    title: m.title.slice(0, 34),
    date: hit?.created || (m.ts || '').slice(0, 10) || null,
    ts: m.ts,
    file: m.file,
    views: hit?.views ?? null,
    likes: hit?.likes ?? null,
    comments: hit?.comments ?? null,
    shares: null, // API에 공유 카운트 필드 없음
    matched: !!hit,
  });
}

// 장부가 비면 발견한 글을 그대로 덤프
if (!rows.length) {
  for (const p of posts) console.log(JSON.stringify(p));
  console.error(`(no ledger; dumped ${posts.length} API posts)`);
  process.exit(0);
}

// 날짜 역순 후 최근 LIMIT개만 (장부 ts 기준 — LinkedIn 발행 장부 교차참조는 채널 결합이라
// 제거, 리멤버 자체 게시 시각으로 충분)
rows.sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0));
if (LIMIT > 0 && rows.length > LIMIT) rows.length = LIMIT;

for (const r of rows) console.log(JSON.stringify(r));

const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
const v = (n) => (n == null ? '-' : String(n));
console.error('title'.padEnd(36) + 'date'.padStart(12) + 'views'.padStart(8) + 'likes'.padStart(8) + 'comments'.padStart(10));
for (const r of rows) {
  console.error(
    r.title.padEnd(36) + v(r.date).padStart(12) + v(r.views).padStart(8) +
    v(r.likes).padStart(8) + v(r.comments).padStart(10) + (r.matched ? '' : '  (not found)')
  );
}
console.error('total'.padEnd(36) + ''.padStart(12) + String(sum('views')).padStart(8) + String(sum('likes')).padStart(8) + String(sum('comments')).padStart(10));
console.error(`(${rows.length} posts · shares not provided by API)`);
