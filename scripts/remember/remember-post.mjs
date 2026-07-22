#!/usr/bin/env node
// Unofficial private API — may break at any time. Experimental channel.
//
// Publish text post(s) to Remember 커넥트 via the internal API (no DOM automation).
//
// POST https://connect-api.rememberapp.co.kr/v1/posts
//   body: { content, attachments: [], og: null, topic_id }
//   auth: Authorization: Token token=<hex>
//
// Token source (in order):
//   1) env REMEMBER_TOKEN  — full header ("Token token=ab..") or raw hex ("ab..")
//   2) CDP capture fallback — connect to the logged-in Chromium (launch-browser.sh)
//      and intercept the Authorization header off any connect-api request,
//      exactly like remember-stats.mjs. Used only when env token is absent/expired.
//
// Usage:
//   node remember-post.mjs posts/x.txt                    # publish one (topic_id=1)
//   node remember-post.mjs --image <path> posts/x.txt     # publish with an image attached
//   node remember-post.mjs --topic-id 1 posts/x.txt       # explicit 주제
//   node remember-post.mjs --topic "AI·테크" posts/x.txt   # legacy alias → topic_id=1
//   node remember-post.mjs posts/a.txt posts/b.txt        # several (8s gap)
//   DRY=1 node remember-post.mjs posts/x.txt              # print body, do NOT post
//   node remember-post.mjs --delete 9004                  # delete a post by id
//   node remember-post.mjs --edit 9004 posts/x.txt        # replace a post's body (PUT /v1/posts/:id)
//
// Image upload flow (reverse-engineered 2026-07-10):
//   1) POST /v1/attachments/presigned-urls {attachment_type,attachment_extension,attachment_size,file_name}
//        → { presigned_url (S3), cdn_url }
//   2) PUT binary to presigned_url with signed headers: content-length + x-amz-meta-file_name
//   3) POST /v1/posts attachments:[{attachment_type,attachment_extension,file_name,url:cdn_url,sequence}]
//
// Ledger (published-remember.jsonl) schema is kept identical to the CDP version so
// remember-stats.mjs matching keeps working.
import { readFileSync, existsSync, appendFileSync } from 'fs';
import path from 'path';
import { getToken, captureTokenViaCDP, persistToken, authHeader } from './token.mjs';
import { loadEnv, home, dataPath, cdpPort } from '../lib/env.mjs';
import { canonicalLink, linkText } from '../lib/canonical-link.mjs';
import { resolveImage } from '../lib/post-image.mjs';

loadEnv();

const DRY = !!process.env.DRY;
const PORT = cdpPort();
const API = 'https://connect-api.rememberapp.co.kr/v1/posts';
const PRESIGN = 'https://connect-api.rememberapp.co.kr/v1/attachments/presigned-urls';
const LEDGER = dataPath('ledgers/published-remember.jsonl');

// --- args: --topic-id <n>  --gap <sec>  --gap-min/max <sec>  --skip-done  --max <n>  files...
const argv = process.argv.slice(2);
let topicId = 1;
let gapSec = 8, gapMin = null, gapMax = null;
let skipDone = false, maxPosts = null;
let deleteId = null;
let editId = null, editFile = null;
let imagePath = null;
const files = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--topic-id' || a === '--topic') { topicId = parseInt(argv[++i], 10) || 1; continue; }
  if (a === '--gap') { gapSec = parseInt(argv[++i], 10) || 8; continue; }
  if (a === '--gap-min') { gapMin = parseInt(argv[++i], 10); continue; }
  if (a === '--gap-max') { gapMax = parseInt(argv[++i], 10); continue; }
  if (a === '--skip-done') { skipDone = true; continue; }
  if (a === '--max') { maxPosts = parseInt(argv[++i], 10) || null; continue; }
  if (a === '--delete') { deleteId = (argv[++i] || '').trim(); continue; }
  if (a === '--edit') { editId = (argv[++i] || '').trim(); editFile = (argv[++i] || '').trim(); continue; }
  if (a === '--image') { imagePath = (argv[++i] || '').trim(); continue; }
  files.push(a);
}
if (imagePath && !existsSync(imagePath)) { console.error(`--image not found: ${imagePath}`); process.exit(1); }
if (editId && !editFile) { console.error('usage: node remember-post.mjs --edit <id> <file>'); process.exit(1); }
if (editId && !existsSync(path.isAbsolute(editFile) ? editFile : path.resolve(editFile))) { console.error(`--edit file not found: ${editFile}`); process.exit(1); }
if (!deleteId && !editId && !files.length) { console.error('no input files'); process.exit(1); }

function nextGap() {
  if (gapMin != null && gapMax != null) {
    const lo = Math.min(gapMin, gapMax), hi = Math.max(gapMin, gapMax);
    return Math.round(lo + Math.random() * (hi - lo));
  }
  return gapSec;
}

function ledgerSet() {
  if (!existsSync(LEDGER)) return new Set();
  return new Set(readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l).file; } catch { return null; } }).filter(Boolean));
}

const ENV_PATH = path.join(home(), '.env');

// Token acquisition (env → CDP cookie capture +persist) lives in token.mjs, shared with
// remember-stats.mjs. Returns { hex, hdr, src }.
async function getAuth() {
  return getToken({ envPath: ENV_PATH, port: PORT });
}

const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

// presign → S3 PUT(서명헤더 content-length + x-amz-meta-file_name) → attachments 항목 반환.
// 서버가 post 생성 시 이 cdn_url을 첨부로 등록(id 부여)한다.
async function uploadAttachment(auth, filePath) {
  const buf = readFileSync(filePath);
  const fileName = path.basename(filePath);
  const ext = (path.extname(fileName).slice(1) || 'png').toLowerCase();
  const hdr = {
    'content-type': 'application/json', accept: '*/*', authorization: auth,
    origin: 'https://connect.rememberapp.co.kr', referer: 'https://connect.rememberapp.co.kr/',
  };
  const pres = await fetch(PRESIGN, {
    method: 'POST', headers: hdr,
    body: JSON.stringify({ attachment_type: 'IMAGE', attachment_extension: ext, attachment_size: buf.length, file_name: fileName }),
  });
  if (!pres.ok) { const e = new Error(`presign ${pres.status}: ${(await pres.text()).slice(0, 200)}`); e.status = pres.status; throw e; }
  const { data } = await pres.json();
  const put = await fetch(data.presigned_url, {
    method: 'PUT',
    headers: { 'content-length': String(buf.length), 'x-amz-meta-file_name': fileName, 'content-type': IMG_MIME[ext] || 'application/octet-stream' },
    body: buf,
  });
  if (!put.ok) throw new Error(`S3 PUT ${put.status}: ${(await put.text()).slice(0, 200)}`);
  return { attachment_type: 'IMAGE', attachment_extension: ext, file_name: fileName, url: data.cdn_url, sequence: 1 };
}

async function post(auth, content, attachments = []) {
  const r = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: '*/*',
      authorization: auth,
      origin: 'https://connect.rememberapp.co.kr',
      referer: 'https://connect.rememberapp.co.kr/',
    },
    body: JSON.stringify({ content, attachments, og: null, topic_id: topicId }),
  });
  const txt = await r.text();
  if (r.status !== 201 && r.status !== 200) {
    const e = new Error(`post ${r.status}: ${txt.slice(0, 200)}`);
    e.status = r.status;
    throw e;
  }
  let id = null;
  try { id = JSON.parse(txt)?.id ?? JSON.parse(txt)?.data?.id ?? null; } catch {}
  return id;
}

async function del(auth, id) {
  const r = await fetch(`${API}/${id}`, {
    method: 'DELETE',
    headers: {
      accept: '*/*',
      authorization: auth,
      origin: 'https://connect.rememberapp.co.kr',
      referer: 'https://connect.rememberapp.co.kr/',
    },
  });
  if (r.status !== 200 && r.status !== 204) {
    const e = new Error(`delete ${r.status}: ${(await r.text()).slice(0, 200)}`);
    e.status = r.status;
    throw e;
  }
}

// 검증됨(2026-07-11 실측): Remember 커넥트는 PUT /v1/posts/:id 로 게시물 본문 수정 지원.
// 발행과 동일한 전체 바디 { content, attachments:[], og:null, topic_id } 를 보내야 함
// (부분 { content }만 보내면 "올바른 요청이 아닙니다" 거부). PATCH·POST-to-id는 미지원.
async function editPost(auth, id, content) {
  const r = await fetch(`${API}/${id}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      accept: '*/*',
      authorization: auth,
      origin: 'https://connect.rememberapp.co.kr',
      referer: 'https://connect.rememberapp.co.kr/',
    },
    // PUT /v1/posts/:id 로 #update (검증 2026-07-11). 발행과 동일한 전체 바디 필수 —
    // { content }만 보내면 "올바른 요청이 아닙니다" 거부. (PATCH·POST-to-id는 "method not supported".)
    body: JSON.stringify({ content, attachments: [], og: null, topic_id: 1 }),
  });
  const txt = await r.text();
  if (r.status !== 200 && r.status !== 201 && r.status !== 204) {
    const e = new Error(`edit ${r.status}: ${txt.slice(0, 200)}`);
    e.status = r.status;
    throw e;
  }
}

// --- run
let auth, authSrc, cdpTried = false;
if (!DRY) { const a = await getAuth(); auth = a.hdr; authSrc = a.src; console.log(`token src: ${a.src}${a.src === 'env' ? ' (browserless)' : ''}`); }

// env 토큰은 수십 분 내 회전(2026-06-30 실측) → stale면 401. 그때 CDP 라이브 세션에서
// 신선 토큰을 1회 캡처해 재시도. 토큰이 죽어도 자동 복구(브라우저 떠 있을 때).
async function refreshViaCDP() {
  if (cdpTried) return false;
  cdpTried = true;
  console.error('  → env token got 401, retrying with a fresh CDP capture…');
  try { const hex = await captureTokenViaCDP(PORT); auth = authHeader(hex); authSrc = 'cdp'; persistToken(hex, ENV_PATH); return true; }
  catch (e) { console.error(`  → CDP fallback failed: ${e.message}`); return false; }
}

if (deleteId) {
  for (;;) {
    try { await del(auth, deleteId); console.log(`deleted post ${deleteId}`); process.exit(0); }
    catch (e) {
      if (e.status === 401 && authSrc === 'env' && await refreshViaCDP()) continue;
      console.error(`delete FAILED - ${e.message}`); process.exit(3);
    }
  }
}

if (editId) {
  // content 조립을 발행과 동일하게(raw 파일 + 정본 링크 트레일러) 맞춰, 수정 후 본문이
  // 재발행 결과와 일치하게 한다.
  const fp = path.isAbsolute(editFile) ? editFile : path.resolve(editFile);
  let content = readFileSync(fp, 'utf8').trim();
  const link = canonicalLink(editFile);
  if (link) content += `\n\n${linkText()}: ${link}`;
  if (DRY) { console.log(`--edit ${editId}: DRY (len=${content.length}${link ? `, link=${link}` : ', no-link'}) — not edited`); process.exit(0); }
  for (;;) {
    try { await editPost(auth, editId, content); console.log(`edited: ${editId} (len=${content.length})`); process.exit(0); }
    catch (e) {
      if (e.status === 401 && authSrc === 'env' && await refreshViaCDP()) continue;
      console.error(`edit FAILED - ${e.message}`);
      if (e.status === 404 || e.status === 405) console.error('  → if edit is unsupported, fall back to delete + republish.');
      process.exit(3);
    }
  }
}

// 이미지 첨부: 한 번 업로드해 모든 파일 게시에 재사용(같은 파일 참조 안전)
let attachment = null;
if (imagePath && !DRY) {
  try { attachment = await uploadAttachment(auth, imagePath); console.log(`image uploaded: ${attachment.file_name} → ${attachment.url}`); }
  catch (e) {
    if (e.status === 401 && authSrc === 'env' && await refreshViaCDP()) { attachment = await uploadAttachment(auth, imagePath); }
    else { console.error(`image upload FAILED - ${e.message}`); process.exit(3); }
  }
}

const done = skipDone ? ledgerSet() : new Set();
let ok = 0, published = 0;
for (let i = 0; i < files.length; i++) {
  const file = files[i];
  if (skipDone && done.has(file)) { console.log(`${file}: skip (already in ledger)`); ok++; continue; }
  const fp = path.isAbsolute(file) ? file : path.resolve(file);
  if (!existsSync(fp)) { console.error(`${file}: FAILED - file not found`); continue; }
  let content = readFileSync(fp, 'utf8').trim();
  // 원문 링크 트레일러: CANONICAL_BASE_URL이 설정돼 있으면 파일명에서 유도한 slug로
  // 링크를 본문 말미에 붙인다 (미설정이면 링크 없이 게시).
  const link = canonicalLink(file);
  if (link) content += `\n\n${linkText()}: ${link}`;

  if (DRY) {
    console.log(`${path.basename(file)}: DRY (topic_id=${topicId}, len=${content.length}${link ? `, link=${link}` : ', no-link'}) — not posted`);
    ok++;
    continue;
  }

  // Explicit --image (uploaded once above) is reused for every file in the batch.
  // Otherwise auto-resolve this file's sibling cover image (best-effort — an
  // upload failure falls back to text-only, it must never sink the post itself).
  let att = attachment;
  if (!imagePath) {
    const auto = resolveImage(file);
    if (auto?.imageAbs) {
      try {
        att = await uploadAttachment(auth, auto.imageAbs);
        console.log(`  auto-image: ${att.file_name} → ${att.url}`);
      } catch (e) {
        if (e.status === 401 && authSrc === 'env' && await refreshViaCDP()) {
          try { att = await uploadAttachment(auth, auto.imageAbs); }
          catch { att = null; console.error('  auto-image upload failed → publishing text-only'); }
        } else { att = null; console.error(`  auto-image upload failed → publishing text-only: ${e.message}`); }
      }
    }
  }

  for (;;) {
    try {
      const id = await post(auth, content, att ? [att] : []);
      appendFileSync(LEDGER, JSON.stringify({ file, topic: topicId, ts: new Date().toISOString() }) + '\n');
      console.log(`${path.basename(file)}: published to Remember (id=${id ?? '?'}, topic_id=${topicId}, len=${content.length}${att ? ', +image' : ''})`);
      ok++; published++;
      break;
    } catch (e) {
      if (e.status === 401 && authSrc === 'env' && await refreshViaCDP()) continue;
      console.error(`${file}: FAILED - ${e.message}`);
      if (e.status === 401) console.error('  → token expired and CDP fallback unavailable. Refresh REMEMBER_TOKEN or run npm run browser to log in.');
      break;
    }
  }

  if (maxPosts && published >= maxPosts) { console.log(`reached --max ${maxPosts}, stopping`); break; }
  if (i < files.length - 1) {
    const g = nextGap();
    console.log(`  next post in ~${g}s`);
    await new Promise((res) => setTimeout(res, g * 1000));
  }
}
console.log(`done: ${ok}/${files.length}`);
process.exit(ok === files.length ? 0 : 3);
