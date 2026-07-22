#!/usr/bin/env node
// Publish a post to Brunch (brunch.co.kr) via the logged-in Chromium (CDP :9224).
// Brunch has no official publish API, and its internal POST /v1/article endpoint
// requires state the editor's own JS sets up client-side (article draft id, keyword
// step) — a raw injected fetch() silently no-ops. So this drives the real editor UI
// (Froala contenteditable fields + 발행 button + 키워드 선택 step), same as a human
// would, and reads back the resulting article URL.
//
// Usage:
//   node post-api.mjs <file>                    # publish, auto-appends canonical source URL
//   node post-api.mjs --status draft <file>      # save as draft instead of publishing
//   node post-api.mjs --url <url> <file>         # override auto-detected source URL
//   node post-api.mjs --no-url <file>            # omit source-url line entirely
//   node post-api.mjs --cover-color [1-10] <file> # colored cover instead of plain text
//   node post-api.mjs --image <path> <file>       # upload an image into the body top
//   node post-api.mjs --delete <articleNo>       # delete a published/draft article
//   node post-api.mjs --edit <articleNo> <file>  # edit an existing article IN-PLACE (같은 articleNo)
//        (검증됨 2026-07-11: /write 에디터 → GET/DELETE /v1/article/temp/{id} → POST /v1/article/{id}.
//         title/subtitle/body만 교체 — 원문링크 트레일러·이미지는 재부착 안 함)
//
// Cover color presets (1-indexed, cycled via the editor's own carousel — Brunch has
// no arbitrary hex picker in the UI, only this fixed 10-color palette):
//   1 #F67066 coral   2 #F8972E orange  3 #FABB11 gold    4 #23B877 green  5 #00C6BE teal
//   6 #50A1C3 blue    7 #7878BC purple  8 #536B82 slate   9 #A97857 brown  10 #555555 gray
import { chromium } from 'playwright';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import { loadEnv, dataPath, cdpPort } from '../lib/env.mjs';

loadEnv();

const PORT = cdpPort();
const LEDGER = dataPath('ledgers/published-brunch.json');
// Optional: base URL prepended to the canonical source-url trailer (see .env.example).
// Unset → source-url auto-detection is skipped (--url/--no-url still work explicitly).
const CANONICAL_BASE_URL = process.env.CANONICAL_BASE_URL || null;

// --- args ---
const argv = process.argv.slice(2);
let status = 'publish';
let sourceUrl; // undefined = auto-detect, null = --no-url, string = override
let file = null;
let deleteId = null;
let editArticleNo = null; // --edit <articleNo>: replace an existing article's body + re-publish
let coverColor = null; // 1-10, null = plain cover_text (no background)
let imagePath = null; // --image <path>: uploaded into the body top via Froala's file input
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--status') { status = argv[++i]; continue; }
  if (argv[i] === '--url') { sourceUrl = argv[++i]; continue; }
  if (argv[i] === '--no-url') { sourceUrl = null; continue; }
  if (argv[i] === '--image') { imagePath = argv[++i]; continue; }
  if (argv[i] === '--delete') { deleteId = argv[++i]; continue; }
  if (argv[i] === '--edit') { editArticleNo = argv[++i]; continue; }
  if (argv[i] === '--cover-color') {
    const next = argv[i + 1];
    if (next && /^\d+$/.test(next)) { coverColor = parseInt(next, 10); i++; }
    else coverColor = 1;
    continue;
  }
  file = argv[i];
}
if (coverColor != null && (coverColor < 1 || coverColor > 10)) {
  console.error('--cover-color must be 1-10');
  process.exit(1);
}
if (imagePath && !existsSync(imagePath)) {
  console.error(`--image file not found: ${imagePath}`);
  process.exit(1);
}
// --edit requires an article number AND a file; validate up front so a malformed call
// exits before we open a CDP connection to the browser.
if (editArticleNo && !file) {
  console.error('usage: node post-api.mjs --edit <articleNo> <file>');
  process.exit(1);
}
if (editArticleNo && file && !existsSync(file)) {
  console.error(`--edit file not found: ${file}`);
  process.exit(1);
}
if (!deleteId && !file) {
  console.error('usage: node post-api.mjs [--status draft|publish] [--url <url>|--no-url] <file>');
  console.error('       node post-api.mjs --delete <articleNo>');
  console.error('       node post-api.mjs --edit <articleNo> <file>');
  process.exit(1);
}

// Slug from the input filename — same convention the other channel scripts use for
// canonical-link resolution: dated `posts/YYYY-MM-DD_<slug>.txt`, or a bare
// `posts-insights/<slug>.txt` / `posts/<slug>.txt` where the filename IS the slug.
function slugFromFile(inputFile) {
  const base = path.basename(inputFile);
  const dated = base.match(/^\d{4}-\d{2}-\d{2}_(.+)\.\w+$/);
  return dated ? dated[1] : base.replace(/\.\w+$/, '');
}

// Canonical source URL: CANONICAL_BASE_URL/<slug>, or null if CANONICAL_BASE_URL isn't
// configured (trailer/source-url logic is then skipped entirely).
function detectSourceUrl(inputFile) {
  if (!CANONICAL_BASE_URL) return null;
  return `${CANONICAL_BASE_URL.replace(/\/+$/, '')}/${slugFromFile(inputFile)}`;
}

// Best-guess editor URL for an existing article, grounded in the publish ledger's own
// url fields (shape: https://brunch.co.kr/@<userid>/<articleNo>) plus the finalUrl regex's
// optional "/write" suffix, which is how the editor URL for an existing article looks.
// Prefer the exact ledger entry for this articleNo; else derive @<userid> from any entry.
// Returns null when neither is resolvable (caller aborts). NOTE: the edit-entry UI is not
// driven live here, so this URL — and the pre-fill/re-publish steps that follow — are
// UNVERIFIED end-to-end.
function editUrlFor(articleNo) {
  let ledger = [];
  if (existsSync(LEDGER)) { try { ledger = JSON.parse(readFileSync(LEDGER, 'utf8')); } catch {} }
  const hit = ledger.find((e) => String(e.articleNo) === String(articleNo) && e.url);
  if (hit) return `${hit.url.replace(/\/+$/, '')}/write`;
  const any = ledger.find((e) => /brunch\.co\.kr\/@[^/]+/.test(e.url || ''));
  const handle = any ? (any.url.match(/brunch\.co\.kr\/(@[^/]+)/) || [])[1] : null;
  return handle ? `https://brunch.co.kr/${handle}/${articleNo}/write` : null;
}

async function fillContentEditable(locator, text) {
  await locator.click();
  await locator.evaluate((el, val) => {
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, val);
  }, text);
}

// paragraphs = array of paragraph strings (each may itself contain \n line breaks,
// e.g. a bullet list) — Enter starts a new Brunch block, Shift+Enter is a soft break.
// Brunch paragraph blocks have no built-in margin, so a single Enter renders paragraphs
// flush against each other — press Enter twice (one blank block) between paragraphs for
// the visual breathing room a normal blog post needs. Lines within one paragraph (e.g.
// bullets) stay on soft breaks with no extra spacing.
async function typeBody(page, locator, paragraphs, { preserveExisting = false } = {}) {
  await locator.click();
  if (!preserveExisting) {
    // fresh body: wipe the editor placeholder before typing.
    await locator.evaluate((el) => { el.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); });
  } else {
    // an image (or other block) is already in the body — do NOT clear it. Put the caret
    // at the very end and open a fresh paragraph so text lands after the existing block.
    await locator.evaluate((el) => {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.press('Enter');
  }
  for (let i = 0; i < paragraphs.length; i++) {
    const lines = paragraphs[i].split('\n');
    for (let j = 0; j < lines.length; j++) {
      if (j > 0) await page.keyboard.press('Shift+Enter');
      if (lines[j]) await locator.evaluate((el, t) => document.execCommand('insertText', false, t), lines[j]);
    }
    if (i < paragraphs.length - 1) { await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); }
  }
}

// Ensure a paste-friendly raster (Brunch's clipboard-paste upload handler accepts
// png/jpeg; webp/heic/gif from a synthetic paste get dropped). Convert with macOS sips
// when needed — this tool is macOS-only, so sips is available.
function ensurePastablePng(imgPath) {
  if (/\.(png|jpe?g)$/i.test(imgPath)) return imgPath;
  const out = path.join(os.tmpdir(), `brunch-paste-${path.basename(imgPath).replace(/\.\w+$/, '')}.png`);
  execFileSync('sips', ['-s', 'format', 'png', imgPath, '--out', out], { stdio: 'ignore' });
  return out;
}

// Insert an image at the top of the (empty) body. Brunch's image button is a hidden
// <input type=file> submitting a form to /v2/upload, but neither setInputFiles nor a
// synthetic form submit fires its handler (the upload is armed by the editor's own click
// path, and the change listener ignores untrusted events). What DOES work end-to-end is
// the editor's clipboard-paste path (brunchEditor.clipboardImagePaste): dispatch a real
// ClipboardEvent carrying the image File, and Brunch uploads to its CDN and inserts the
// <img> block itself. We then wait until that <img> carries a real http(s) src —
// publishing before the async upload finishes would ship a broken image.
async function insertImageAtTop(page, imgPath) {
  const pastable = ensurePastablePng(imgPath);
  const b64 = readFileSync(pastable).toString('base64');
  const body = page.locator('div.wrap_body');
  await body.click();
  // NOTE: do not selectAll+delete here — that strips the editor's empty item block, and
  // Brunch's paste handler needs a valid caret inside an item to insert the image. The
  // body is already empty on a fresh /write page, so there is nothing to clear anyway.
  await body.evaluate((el, data) => {
    const bin = atob(data);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], 'insert.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.focus();
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, b64);
  await page.waitForFunction(() => {
    const img = document.querySelector('.wrap_body img');
    return !!(img && img.src && /^https?:\/\//.test(img.src) && !img.src.startsWith('blob:'));
  }, { timeout: 45000 });
  await page.waitForTimeout(1000);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { noDefaults: true });
const ctx = browser.contexts()[0];
// 통합 브라우저(:9224)에는 LinkedIn·리멤버·FB·네이버 탭도 함께 뜬다 — 반드시 brunch.co.kr 탭을 골라야
// /v2/me·에디터 fetch가 same-origin으로 돈다(엉뚱한 탭이면 CORS "Failed to fetch").
const page =
  ctx.pages().find((p) => p.url().includes('brunch.co.kr')) || ctx.pages()[0] || (await ctx.newPage());
await page.bringToFront();
// brunch.co.kr 탭이 하나도 없으면(예: 네이버 발행이 유일 페이지를 점유해 about:blank만 남은 경우)
// 선택된 페이지가 엉뚱한 오리진이라 아래 /v2/me·상세·발행 fetch가 CORS "Failed to fetch"로 죽는다.
// 실제 발행 전에 brunch.co.kr로 먼저 이동시켜 모든 fetch를 same-origin으로 만든다.
if (!page.url().includes('brunch.co.kr')) {
  await page.goto('https://brunch.co.kr', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
}

if (deleteId) {
  const res = await page.evaluate(async (id) => {
    const r = await fetch(`https://api.brunch.co.kr/v1/article/${id}`, { method: 'DELETE', credentials: 'include' });
    return { status: r.status, text: await r.text() };
  }, deleteId);
  console.log('delete', deleteId, JSON.stringify(res));
  await browser.close();
  process.exit(res.status >= 200 && res.status < 300 ? 0 : 1);
}

// login check
const loggedOut = await page.evaluate(async () => {
  const r = await fetch('https://api.brunch.co.kr/v2/me', { credentials: 'include' });
  const j = await r.json().catch(() => null);
  return !j?.data?.profileId;
});
if (loggedOut) {
  console.error(`not logged in — open the visible Chromium (:${PORT}) and log in with Kakao (as the account owner), then retry.`);
  await browser.close();
  process.exit(2);
}

// --- edit (skeleton) ---
// Self-contained early branch mirroring the --delete branch's shape (do → close → exit)
// so the working publish path below is left byte-for-byte untouched. Reuses the module-
// level editor helpers (fillContentEditable/typeBody) against the existing article's
// editor, then the same 발행→키워드→완료 confirm as a fresh publish.
// VERIFIED 2026-07-11 (throwaway 발행→edit→공개페이지 마커 확인): /write 에디터를 몰아 발행하면
// 브런치가 GET/DELETE /v1/article/temp/{id} → POST /v1/article/{id}(form-urlencoded title/subTitle/content)
// 로 in-place 수정한다(같은 articleNo 유지). 단 title/subtitle/body만 교체 — 원문링크 트레일러·
// 이미지는 재부착하지 않는다(필요하면 수동 또는 --delete + 재발행).
if (editArticleNo) {
  const editUrl = editUrlFor(editArticleNo);
  if (!editUrl) {
    console.error(`cannot resolve edit URL for articleNo ${editArticleNo} (no ledger entry / @userid) — edit on the web, or --delete + re-publish.`);
    await browser.close();
    process.exit(1);
  }
  const raw = readFileSync(file, 'utf8').trim();
  const lines = raw.split('\n');
  const title = lines[0].trim();
  if (title.length > 30) {
    console.error(`title exceeds Brunch's 30-char limit (${title.length}자): "${title}"`);
    await browser.close();
    process.exit(1);
  }
  const rest = lines.slice(1).join('\n').trim();
  const restParagraphs = rest.split(/\n\s*\n/).filter(Boolean);
  const subTitle = restParagraphs[0].split('\n')[0].trim();
  if (subTitle.length > 40) {
    console.error(`subtitle (body's first line) exceeds Brunch's 40-char limit (${subTitle.length}자): "${subTitle}"`);
    await browser.close();
    process.exit(1);
  }

  console.log('edit articleNo:', editArticleNo);
  console.log('edit url:', editUrl);
  console.log('title:', title);
  console.log('subTitle:', subTitle);

  await page.goto(editUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  // The editor loads with the existing title/subtitle/body — the fill helpers selectAll
  // before inserting, so they overwrite rather than append.
  await fillContentEditable(page.locator('h1.cover_title'), title);
  await fillContentEditable(page.locator('div.cover_sub_title'), subTitle);
  await typeBody(page, page.locator('div.wrap_body'), restParagraphs);
  await page.waitForTimeout(800);

  // re-publish — identical UI steps to a fresh publish (발행 → 키워드 패널 → 완료).
  let publishedOk = false, lastErr;
  await page.locator('button.article_save_publish').click({ timeout: 8000 });
  await page.waitForResponse((r) => r.url().includes('/v1/keyword/recommend'), { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  const doneBtn = page.locator('#PublishSideMenu button.save');
  for (let attempt = 1; attempt <= 3 && !publishedOk; attempt++) {
    try { await doneBtn.click({ timeout: 10000 }); publishedOk = true; }
    catch (e) { lastErr = e; await page.waitForTimeout(1500); }
  }
  await browser.close();
  if (!publishedOk) { console.error(`edit re-publish confirm FAILED: ${lastErr?.message}`); process.exit(1); }
  console.log(`edited: articleNo ${editArticleNo}`);
  process.exit(0);
}

const raw = readFileSync(file, 'utf8').trim();
const lines = raw.split('\n');
const title = lines[0].trim();
// Brunch hard-caps titles at 30 chars ("제목은 30글자 이상 입력할 수 없습니다.") — over the
// limit, the 발행 click silently no-ops (no error dialog, no keyword panel, nothing),
// which just times out waiting for a UI step that will never appear. Fail fast instead.
if (title.length > 30) {
  console.error(`title exceeds Brunch's 30-char limit (${title.length}자): "${title}"`);
  console.error('shorten the first line of the input file and retry.');
  process.exit(1);
}
const rest = lines.slice(1).join('\n').trim();
const restParagraphs = rest.split(/\n\s*\n/).filter(Boolean);
const subTitle = restParagraphs[0].split('\n')[0].trim();
// Same story as the title, but 40 chars — "소제목은 40글자 이상 입력할 수 없습니다." Subtitle is
// derived from the body's first line, so this is a content-authoring constraint, not
// something fixable here; fail fast with a clear message instead of a silent timeout.
if (subTitle.length > 40) {
  console.error(`subtitle (body's first line) exceeds Brunch's 40-char limit (${subTitle.length}자): "${subTitle}"`);
  console.error('shorten the first paragraph of the input file and retry.');
  process.exit(1);
}

const resolvedUrl = sourceUrl === null
  ? null
  : (sourceUrl || detectSourceUrl(file));
const bodyParagraphs = [...restParagraphs];

console.log('title:', title);
console.log('subTitle:', subTitle);
console.log('sourceUrl:', resolvedUrl ?? '(none)');
console.log('image:', imagePath ?? '(none)');
console.log('status:', status);
console.log('coverColor:', coverColor ?? '(none — plain text cover)');

await page.goto('https://brunch.co.kr/write', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(1500);

// "임시저장된 글이 있습니다" restore-draft dialog can intercept every click if a
// prior run left an autosave — always start fresh (아니요).
const restoreDialog = page.locator('#TempContentMessage');
if (await restoreDialog.count()) {
  await restoreDialog.getByRole('button', { name: '아니요' }).click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
}

// switch to a colored cover BEFORE filling title/subtitle — the toggle re-renders
// the cover block and would otherwise wipe already-typed text.
if (coverColor != null) {
  await page.locator('button[title="커버 배경색"]').click({ timeout: 8000 });
  await page.waitForTimeout(500);
  for (let i = 1; i < coverColor; i++) {
    await page.locator('.cover_color_arrow_next').first().click({ timeout: 5000 });
    await page.waitForTimeout(250);
  }
}

await fillContentEditable(page.locator('h1.cover_title'), title);
await fillContentEditable(page.locator('div.cover_sub_title'), subTitle);
if (imagePath) {
  await insertImageAtTop(page, imagePath);
  await typeBody(page, page.locator('div.wrap_body'), bodyParagraphs, { preserveExisting: true });
} else {
  await typeBody(page, page.locator('div.wrap_body'), bodyParagraphs);
}

// source-url line as a real <a href> (insertText leaves it as unlinked plain text)
if (resolvedUrl) {
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.locator('div.wrap_body').evaluate((el, url) => {
    el.focus();
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    document.execCommand('insertHTML', false, `원문: <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`);
  }, resolvedUrl);
}
await page.waitForTimeout(800);

// guard: if an image was requested, refuse to publish without it actually in the body
// (publish-then-verify would leave a live post missing the whole point of --image).
if (imagePath) {
  const imgCount = await page.locator('div.wrap_body img').count();
  if (imgCount < 1) {
    console.error('image insert FAILED — no <img> in body, aborting before publish');
    await browser.close();
    process.exit(1);
  }
}

let finalUrl;
if (status === 'draft') {
  await page.locator('button.article_save_draft').click({ timeout: 8000 });
  await page.waitForTimeout(3000);
  finalUrl = page.url();
} else {
  // The 키워드 선택 panel's load time is variable (network/content-length dependent) —
  // a fixed short sleep flaked intermittently (~40% in a 38-item batch run, 2026-07-04).
  // Wait for the actual /v1/keyword/recommend response instead of guessing. The generic
  // `text=완료` locator also turned out to be too loose — it can resolve to something
  // other than the actual confirm button, and once the panel (#PublishSideMenu) is open,
  // re-clicking 발행 on retry just gets intercepted by that same still-open panel. Scope
  // the click to the panel's own button and only retry the click itself, never 발행.
  let publishedOk = false;
  let lastErr;
  await page.locator('button.article_save_publish').click({ timeout: 8000 });
  await page.waitForResponse((r) => r.url().includes('/v1/keyword/recommend'), { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  try {
    const aiChip = page.locator('button.keyword', { hasText: /AI|인공지능/i }).first();
    if (await aiChip.count()) await aiChip.click({ timeout: 3000 });
  } catch {}
  const doneBtn = page.locator('#PublishSideMenu button.save');
  for (let attempt = 1; attempt <= 3 && !publishedOk; attempt++) {
    try {
      await doneBtn.click({ timeout: 10000 });
      publishedOk = true;
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(1500);
    }
  }
  if (!publishedOk) throw lastErr;
  await page.waitForTimeout(3000);
  finalUrl = page.url();
}

await browser.close();

const m = finalUrl.match(/\/(\d+)(?:\/write)?$/);
const articleNo = m ? m[1] : null;
console.log('final url:', finalUrl, 'articleNo:', articleNo);

if (!articleNo) {
  console.error('publish likely FAILED (no article id in final URL)');
  process.exit(1);
}

const entry = { file: path.basename(file), status, articleNo, url: finalUrl, sourceUrl: resolvedUrl, date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()), ts: new Date().toISOString() };
let ledger = [];
if (existsSync(LEDGER)) { try { ledger = JSON.parse(readFileSync(LEDGER, 'utf8')); } catch {} }
ledger.push(entry);
writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
console.log('published, logged to', LEDGER);
