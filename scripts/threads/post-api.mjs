#!/usr/bin/env node
// Publish a long post to Threads (Meta) as an auto-chunked thread chain (<=500 chars
// per post) plus a trailing link post pointing at the canonical article (if
// CANONICAL_BASE_URL is configured).
// Tokens read from $CROSSPOST_HOME/.env: THREADS_ACCESS_TOKEN / THREADS_USER_ID.
//
//   node post-api.mjs ../linkedin/posts/2026-06-30_x.txt   # publish one file as a chain
//   node post-api.mjs --image-url <https-url> file.txt      # attach an image to the root post (Threads needs a public URL)
//   node post-api.mjs --skip-done file.txt                  # skip files already recorded in the ledger
//   node post-api.mjs a.txt b.txt                          # several (sequential, isolated)
//   node post-api.mjs --delete <thread-id>                 # delete a single post
//   node post-api.mjs --backfill-links                     # retro-attach link trailer to entries posted before their canonical article existed
//
// Edit: Threads Graph API has no publish-edit endpoint — a published post's text cannot
// be changed via the API. To revise a post, --delete it and re-publish.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { loadEnv, dataPath } from '../lib/env.mjs';
import { resolveImage } from '../lib/post-image.mjs';
import { canonicalLink, slugFromFile } from '../lib/canonical-link.mjs';

loadEnv();

const LEDGER = dataPath('ledgers/published-threads.json');
const GRAPH = 'https://graph.threads.net/v1.0';
const LINK_TEXT = process.env.CROSSPOST_LINK_TEXT || 'Read the full article';
const LIMIT = 480; // 500 hard cap, 480 safety margin
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOKEN = process.env.THREADS_ACCESS_TOKEN;
const USER_ID = process.env.THREADS_USER_ID;

// canonicalLink/slugFromFile come from ../lib/canonical-link.mjs so every channel
// builds the same trailer URL (`${CANONICAL_BASE_URL}/<slug>`) and skips the
// trailer entirely when CANONICAL_BASE_URL is unset.

// --- chunking: paragraph-first greedy pack, sentence split, then whitespace hard-split ---
function splitLong(text) {
  if (text.length <= LIMIT) return [text];
  const out = [];
  let buf = '';
  for (const s of text.split(/(?<=[.!?。！？])\s+/)) {
    const cand = buf ? buf + ' ' + s : s;
    if (cand.length <= LIMIT) { buf = cand; continue; }
    if (buf) { out.push(buf); buf = ''; }
    if (s.length <= LIMIT) { buf = s; continue; }
    let piece = s;
    while (piece.length > LIMIT) {
      let cut = piece.lastIndexOf(' ', LIMIT);
      if (cut <= 0) cut = LIMIT; // no space (unbroken Korean run) → hard cut
      out.push(piece.slice(0, cut).trim());
      piece = piece.slice(cut).trimStart();
    }
    buf = piece;
  }
  if (buf) out.push(buf);
  return out;
}

function chunkText(text) {
  const chunks = [];
  let buf = '';
  const flush = () => { if (buf.trim()) chunks.push(buf.trim()); buf = ''; };
  for (const p of text.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean)) {
    if (p.length <= LIMIT) {
      const cand = buf ? buf + '\n\n' + p : p;
      if (cand.length <= LIMIT) buf = cand; else { flush(); buf = p; }
      continue;
    }
    flush();
    for (const piece of splitLong(p)) {
      const cand = buf ? buf + ' ' + piece : piece;
      if (cand.length <= LIMIT) buf = cand; else { flush(); buf = piece; }
    }
    flush();
  }
  flush();
  return chunks;
}

// --- Threads Graph API ---
async function apiPost(node, params) {
  const res = await fetch(`${GRAPH}/${node}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, access_token: TOKEN }).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${node} ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function apiGet(node, params) {
  const qs = new URLSearchParams({ ...params, access_token: TOKEN });
  const res = await fetch(`${GRAPH}/${node}?${qs}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${node} ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function waitFinished(creationId) {
  for (let i = 0; i < 5; i++) {
    await sleep(700);
    let status;
    try { ({ status } = await apiGet(creationId, { fields: 'status' })); } catch { continue; }
    if (status === 'FINISHED') return;
    if (status === 'ERROR') throw new Error(`container ${creationId} status=ERROR`);
  }
  // timeout → proceed anyway (text containers usually finish instantly)
}

async function publishOne({ text, replyToId, linkAttachment, imageUrl }) {
  const params = imageUrl ? { media_type: 'IMAGE', image_url: imageUrl, text } : { media_type: 'TEXT', text };
  if (replyToId) params.reply_to_id = replyToId;
  if (linkAttachment) params.link_attachment = linkAttachment;
  const { id: creationId } = await apiPost(`${USER_ID}/threads`, params);
  if (!creationId) throw new Error('no creation id in create response');
  await waitFinished(creationId);
  const { id } = await apiPost(`${USER_ID}/threads_publish`, { creation_id: creationId });
  if (!id) throw new Error('no media id in publish response');
  return id;
}

async function deletePost(id) {
  const res = await fetch(`${GRAPH}/${id}?access_token=${encodeURIComponent(TOKEN)}`, { method: 'DELETE' });
  const text = await res.text();
  if (!res.ok) {
    // 500 "does not have permission for this action" ⇒ 토큰에 threads_delete 스코프 없음.
    // (400 not-found의 "missing permissions"와 구분 — 그건 스코프 문제 아님.)
    const hint = /does not have permission for this action/i.test(text)
      ? ' — threads_delete scope required (generator token doesn\'t have it; re-issue via custom OAuth)'
      : '';
    throw new Error(`delete ${res.status}: ${text.slice(0, 200)}${hint}`);
  }
}

function recordPublish(rec) {
  const list = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : [];
  if (list.some((e) => e.rootId === rec.rootId)) return;
  list.push({ ...rec, date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()), publishedAt: new Date().toISOString() });
  writeFileSync(LEDGER, JSON.stringify(list, null, 2) + '\n');
}

async function hasLinkTrailer(lastId) {
  try {
    const d = await apiGet(lastId, { fields: 'link_attachment_url' });
    return Boolean(d.link_attachment_url);
  } catch {
    return false; // treat unknown as missing so we can retry; dup reply is harmless-ish but avoid on error
  }
}

// Retro-attach the canonical link trailer to ledger entries that were cross-posted
// BEFORE their canonical article existed (canonicalLink was null → trailer skipped).
// Safe to re-run: entries whose chain already ends with a link post are skipped.
async function backfillLinks() {
  const list = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : [];
  let fixed = 0, skipped = 0, nolink = 0;
  for (const e of list) {
    const ids = e.ids || [];
    if (!ids.length) { skipped++; continue; }
    const link = e.file ? canonicalLink(e.file) : null;
    if (!link) { nolink++; continue; } // still no live article → nothing to attach
    if (await hasLinkTrailer(ids[ids.length - 1])) { skipped++; continue; }
    try {
      const newId = await publishOne({ text: LINK_TEXT, replyToId: ids[ids.length - 1], linkAttachment: link });
      ids.push(newId);
      e.ids = ids;
      writeFileSync(LEDGER, JSON.stringify(list, null, 2) + '\n'); // persist per-item (crash-safe)
      console.log(`${e.slug}: link trailer added ${newId} → ${link}`);
      fixed++;
      await sleep(1500);
    } catch (err) {
      console.error(`${e.slug}: failed to add link ${err.message}`);
    }
  }
  console.log(`backfill complete: added ${fixed} · skipped (existing/blank) ${skipped} · no canonical ${nolink}`);
}

// Threads-optimized body variant `<name>.threads.txt`, or null. Mirrors the
// `.en.txt` idiom in lib/post-body.mjs (exact-name sibling, never a glob).
// Only the BODY swaps to the variant — slug/canonicalLink/resolveImage/ledger
// all stay on the canonical `file`, so `.threads.txt` never leaks into slug
// resolution (which would break the 정본 link/image).
function threadsVariantPath(file) {
  const f = String(file);
  if (!f.endsWith('.txt') || f.endsWith('.threads.txt')) return null;
  return f.replace(/\.txt$/, '.threads.txt');
}

// ids is mutated in place so the caller can report already-published posts on mid-chain failure.
async function publishFile(file, ids, imageUrl) {
  const variant = threadsVariantPath(file);
  const bodySrc = variant && existsSync(variant) ? variant : file;
  if (bodySrc !== file) console.log(`  ↳ using Threads variant body: ${path.basename(bodySrc)}`);
  const text = readFileSync(bodySrc, 'utf8').trim();
  if (!text) throw new Error('empty file');
  const chunks = chunkText(text);
  let replyToId = null;
  for (let i = 0; i < chunks.length; i++) {
    // 이미지는 루트(첫) 포스트에만 붙인다
    const id = await publishOne({ text: chunks[i], replyToId, imageUrl: i === 0 ? imageUrl : null });
    ids.push(id);
    replyToId = id;
    if (i < chunks.length - 1) await sleep(1500);
  }
  // 대응 정본 글이 라이브일 때만 링크 포스트 부착 (없으면 스킵 — 404 트레일러 방지)
  const link = canonicalLink(file);
  if (link) {
    await sleep(1500);
    ids.push(await publishOne({ text: LINK_TEXT, replyToId, linkAttachment: link }));
  } else {
    console.warn(`${file}: no matching canonical post — skipping link post`);
  }
  recordPublish({ file, slug: slugFromFile(file), rootId: ids[0], ids });
  console.log(`${file}: published (${chunks.length} chunks${link ? '+link' : ''}) root=${ids[0]}`);
}

// --- run ---
let argv = process.argv.slice(2);
const skipDone = argv.includes('--skip-done');
if (skipDone) argv = argv.filter((arg) => arg !== '--skip-done');
// --image-url <public https url> : 루트 포스트에 붙일 이미지 (Threads는 공개 URL만 허용, 바이너리 업로드 불가)
let IMAGE_URL = null;
{
  const i = argv.indexOf('--image-url');
  if (i >= 0) { IMAGE_URL = argv[i + 1]; argv = [...argv.slice(0, i), ...argv.slice(i + 2)]; }
}
if (!TOKEN || !USER_ID) {
  console.error('THREADS_ACCESS_TOKEN / THREADS_USER_ID missing in $CROSSPOST_HOME/.env');
  process.exit(1);
}

if (argv[0] === '--delete') {
  const id = argv[1];
  if (!id) { console.error('usage: post-api.mjs --delete <thread-id>'); process.exit(1); }
  await deletePost(id);
  console.log(`deleted: ${id}`);
} else if (argv[0] === '--reply') {
  // Add a single reply to an existing post (non-destructive). Use e.g. to attach a source after the fact.
  const id = argv[1];
  const text = argv[2];
  if (!id || !text) { console.error('usage: post-api.mjs --reply <thread-id> "<text>"'); process.exit(1); }
  const rid = await publishOne({ text, replyToId: id });
  console.log(`replied: ${rid}`);
} else if (argv[0] === '--backfill-links') {
  await backfillLinks();
} else if (argv.length) {
  const done = skipDone
    ? new Set((existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : [])
      .map((entry) => path.basename(entry.file || '')))
    : new Set();
  for (const f of argv) {
    if (!existsSync(f)) {
      console.error(`${f}: not found`);
      process.exitCode = 1;
      continue;
    }
    if (skipDone && done.has(path.basename(f))) {
      console.log(`${f}: skip (already published)`);
      continue;
    }
    // 이미지: 명시 --image-url(실패 시 큰 소리) 또는 자동해석(best-effort).
    // Threads는 공개 URL을 서버가 페치·트랜스코드하므로 정본 배포(발행 순서 2단계) 뒤에 라이브다.
    const auto = IMAGE_URL ? null : resolveImage(f);
    const imgUrl = IMAGE_URL || auto?.imageUrl || null;
    const ids = [];
    try {
      await publishFile(f, ids, imgUrl);
    } catch (e) {
      // 자동 이미지 best-effort: webp 거부·URL 미배포로 루트가 막혔고(아직 아무것도 발행 안 됨)
      // 이미지가 자동해석분이면 텍스트-only로 1회 재시도해 발행 자체를 살린다.
      if (imgUrl && !IMAGE_URL && ids.length === 0) {
        console.error(`  auto-image failed — republishing as text: ${e.message}`);
        try { await publishFile(f, ids, null); }
        catch (e2) {
          console.error(`${f}: FAILED ${e2.message}`);
          if (ids.length) console.error(`  already-published chunks (manual --delete needed): ${ids.join(', ')}`);
          process.exitCode = 1;
        }
      } else {
        console.error(`${f}: FAILED ${e.message}`);
        if (ids.length) console.error(`  already-published chunks (manual --delete needed): ${ids.join(', ')}`);
        process.exitCode = 1;
      }
    }
    await sleep(1500);
  }
} else {
  console.error('usage: post-api.mjs [--skip-done] <file...> | --delete <thread-id> | --backfill-links');
  process.exit(1);
}
