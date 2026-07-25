// Naver blog publisher (SE-ONE UI automation over the logged-in CDP profile).
// There is no official write API — Naver shut the old OAuth writePost.json path
// down in 2020 — so this drives the real SmartEditor ONE web UI.
//
//   node post-api.mjs <file>                    # publish (category defaults to 게시판)
//   node post-api.mjs <file> --category "..."   # override category
//   node post-api.mjs --edit <logNo> <file>     # replace a published post in place (same logNo/url)
//   node post-api.mjs --delete <logNo>          # delete a post
//   node post-api.mjs <file> --dry               # fill + screenshot, do not publish
//   node post-api.mjs <file> --image <path>     # attach a local image as the cover
//   node post-api.mjs <file> --tags "a,b,c"     # Naver tags (else a sibling <base>.tags file)
//
// <file> is a plain-text post: first line = title, rest = body (blank-line separated
// paragraphs; a paragraph starting with "## " renders as a SE-ONE 소제목 heading). When
// CANONICAL_BASE_URL is set, a hyperlinked "<CROSSPOST_LINK_TEXT>: <url>" trailer is
// appended. A sibling cover image (same basename, .png/.jpg/.jpeg/.webp) auto-attaches
// unless --image is given.
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { connect, acquirePage, releasePage } from './cdp.mjs';
import { loadEnv, dataPath } from '../lib/env.mjs';
import { readPostBody } from '../lib/post-body.mjs';
import { canonicalLink, slugFromFile, linkText } from '../lib/canonical-link.mjs';
import { resolveImage } from '../lib/post-image.mjs';

loadEnv();

const LEDGER = dataPath('ledgers/published-naver.json');
const BLOG_ID = process.env.NAVER_BLOG_ID;
if (!BLOG_ID) { console.error('NAVER_BLOG_ID not set in $CROSSPOST_HOME/.env'); process.exit(1); }
const DEFAULT_CATEGORY = '게시판';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const flag = (n) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : null; };

// ---------- ledger ----------
const readLedger = () => (existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : []);
function recordLedger(rec) {
  const l = readLedger();
  const i = l.findIndex((e) => e.logNo === rec.logNo || e.slug === rec.slug);
  if (i !== -1) l[i] = { ...l[i], ...rec }; else l.push(rec);
  writeFileSync(LEDGER, JSON.stringify(l, null, 2) + '\n');
}

// ---------- post content ----------
function loadPost(file) {
  const raw = readPostBody(file).trim();
  const [titleLine, ...rest] = raw.split('\n');
  return { title: (titleLine || '').trim(), body: rest.join('\n').trim() };
}
// explicit --image wins; else auto-attach a sibling cover image if one exists.
function coverImage(file, explicit) {
  if (explicit) return explicit;
  return resolveImage(file)?.imageAbs || null;
}

// ---------- SE-ONE rendering ----------
let page, frame;
const type = (t) => page.keyboard.type(t, { delay: 4 });
const enter = async () => { await page.keyboard.press('Enter'); await page.waitForTimeout(70); };
async function setFormat(opt) { // 본문 / 소제목 / 인용구 (applies to current line)
  await frame.locator('.se-text-format-toolbar-button').first().click();
  await page.waitForTimeout(450);
  await frame.locator(`button.se-toolbar-option-text-button:has-text("${opt}")`).first().click({ timeout: 3000 });
  await page.waitForTimeout(350);
}
const divider = () => frame.locator('button[data-name="horizontal-line"]').first().click({ timeout: 3000 }).then(() => page.waitForTimeout(300)).catch(() => {});
async function insertImage(absPath) {
  try {
    const [fc] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 8000 }),
      frame.locator('button[data-name="image"]').first().click(),
    ]);
    await fc.setFiles(absPath);
    await page.waitForTimeout(5000);
    return true;
  } catch (e) { console.error('  image insert failed:', e.message.slice(0, 50)); return false; }
}
async function linkCurrentLine(url) {
  await page.keyboard.press('Home');
  await page.keyboard.down('Shift'); await page.keyboard.press('End'); await page.keyboard.up('Shift');
  await page.waitForTimeout(200);
  await frame.locator('button[data-name="text-link"]').first().click();
  await page.waitForTimeout(600);
  const input = frame.locator('.se-link-input, .se-popup input[type="text"]').first();
  await input.fill(url).catch(async () => { await page.keyboard.type(url, { delay: 5 }); });
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter').catch(() => {});
  await frame.locator('.se-link-apply-button, button:has-text("확인")').first().click({ timeout: 1500 }).catch(() => {});
  await page.waitForTimeout(400);
}
async function renderBody(body, imageAbs, canonicalUrl) {
  // cover image
  if (imageAbs && existsSync(imageAbs)) { await insertImage(imageAbs); await enter(); }
  // body paragraphs (blank-line separated; "## " prefix → 소제목 heading)
  await setFormat('본문');
  for (const para of body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    if (para.startsWith('## ')) {
      await setFormat('소제목'); await type(para.slice(3).trim()); await enter(); await setFormat('본문');
      continue;
    }
    for (const line of para.split('\n')) { await type(line); await enter(); }
  }
  // hyperlinked canonical trailer
  if (canonicalUrl) {
    await divider();
    await type(`${linkText()}: ${canonicalUrl}`);
    await linkCurrentLine(canonicalUrl);
    await page.waitForTimeout(400);
  }
}
async function dismissDraftAlert() {
  const cancel = frame.locator('.se-popup-alert .se-popup-button-cancel');
  if (await cancel.count().catch(() => 0)) { await cancel.first().click().catch(() => {}); await page.waitForTimeout(700); }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
}
// ---------- tags ----------
// Naver tags come from `--tags "a,b,c"` or a sibling `<basename>.tags` file
// (comma- or newline-separated), same sibling convention as the cover image.
//
// Two silent failure modes, both verified against the live editor (2026-07-25):
//   * A space acts as a SEPARATOR — "AI 법률 상담" is stored as three tags
//     (AI / 법률 / 상담) and trailing keywords get dropped.
//   * A special character is REJECTED and takes the tags after it with it —
//     entering `yt-dlp` silently swallowed the following `vibecoding`.
// So we keep Hangul and alphanumerics only, and verify by counting the chips
// the editor actually committed.
const MAX_TAGS = 10;
function toTags(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    const t = String(raw).replace(/[^가-힣ㄱ-ㅎㅏ-ㅣa-zA-Z0-9]/g, '').slice(0, 30);
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}
function resolveTags(file, cliTags) {
  if (cliTags) return toTags(cliTags.split(','));
  const sib = file.replace(/\.\w+$/, '') + '.tags';
  if (existsSync(sib)) return toTags(readFileSync(sib, 'utf8').split(/[,\n]/));
  return [];
}
const chipCount = () => frame.evaluate(() => {
  const a = document.querySelector('[class*="tag_area"],[class*="tag_textarea"]');
  return a ? a.querySelectorAll('span[class*="text__"]').length : -1;
}).catch(() => -1);
// Existing tags are cleared first so re-publishing an edited post doesn't accumulate.
async function clearTags() {
  let n = await chipCount();
  for (let i = 0; n > 0 && i < 40; i++) {
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(180);
    const next = await chipCount();
    if (next === n) break;
    n = next;
  }
}
async function fillTags(tags) {
  if (!tags.length) return 0;
  const input = frame.locator('input[class*="tag_input__"]').first();
  if (!(await input.count().catch(() => 0))) { console.error('  tag input not found — skipping tags'); return 0; }
  await input.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  if ((await chipCount()) > 0) await clearTags();
  for (const t of tags) {
    await input.type(t, { delay: 12 });
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    // A rejected tag leaves text behind and would merge into the next one.
    const left = await input.inputValue().catch(() => '');
    if (left) { await input.fill('').catch(() => {}); await page.waitForTimeout(150); }
  }
  const n = await chipCount();
  console.log(`  tags: ${tags.length} entered → ${n} committed${n === tags.length ? '' : '  *** MISMATCH ***'}: ${tags.join(', ')}`);
  return n;
}

async function publishPopup(category, tags) {
  await frame.locator('button[class*="publish_btn__"]').first().click();
  await page.waitForTimeout(2500);
  // category select
  await frame.locator('button[class*="selectbox_button__"]').first().click();
  await page.waitForTimeout(800);
  await frame.locator(`text="${category}"`).last().click({ timeout: 5000 });
  await page.waitForTimeout(600);
  await fillTags(tags || []);
}
function logNoFromUrl(u) { const m = u.match(/blog\.naver\.com\/[^/]+\/(\d+)/) || u.match(/logNo=(\d+)/); return m ? m[1] : null; }

// ---------- flows ----------
async function withBrowser(fn) {
  // Reuse an existing tab instead of piling up a new one each run (shared browser).
  const { browser, ctx } = await connect();
  page = await acquirePage(ctx);
  await page.bringToFront().catch(() => {}); // 백그라운드 탭은 rAF 스로틀 → SE-ONE 레이아웃이 영원히 "not stable"
  page.on('dialog', (d) => { console.log('  dialog:', d.message().slice(0, 45)); d.accept().catch(() => {}); });
  try { return await fn(); }
  finally { await releasePage(page); await browser.close().catch(() => {}); }
}

async function doPublish(file, categoryOverride, imageOverride, tagsOverride) {
  const post = loadPost(file);
  const slug = slugFromFile(file) || file;
  const category = categoryOverride || DEFAULT_CATEGORY;
  const canonicalUrl = canonicalLink(file);
  const image = coverImage(file, imageOverride);
  console.log(`publish: ${post.title} → ${category} | image=${image ? 'yes' : 'no'}`);
  return withBrowser(async () => {
    await page.goto(`https://blog.naver.com/${BLOG_ID}?Redirect=Write&`, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(8500); // SE-ONE 초기 레이아웃 settle 대기 (6s는 제목 클릭 "not stable" 유발)
    frame = page.frames().find((f) => /PostWriteForm/i.test(f.url()));
    if (!frame) throw new Error('editor frame not found');
    await dismissDraftAlert();
    const titleLoc = frame.locator('.se-section-documentTitle .se-text-paragraph, .se-documentTitle .se-text-paragraph').first();
    await titleLoc.click({ timeout: 8000 }).catch(async () => { await titleLoc.click({ force: true }); }); // 애니메이션 중이면 force 폴백
    await page.waitForTimeout(600); await type(post.title); await page.waitForTimeout(600);
    const bodyLoc = frame.locator('.se-component.se-text .se-text-paragraph').first();
    await bodyLoc.click({ timeout: 8000 }).catch(async () => { await bodyLoc.click({ force: true }); }); // 제목 입력 후 레이아웃 시프트 → force 폴백
    await page.waitForTimeout(300);
    await renderBody(post.body, image, canonicalUrl);
    await page.screenshot({ path: dataPath('tmp/naver-post-filled.png'), fullPage: true });
    await publishPopup(category, resolveTags(file, tagsOverride));
    if (DRY) { console.log('--dry: not publishing'); return; }
    await frame.locator('button[class*="confirm_btn__"]').first().click();
    await page.waitForTimeout(6000);
    const logNo = logNoFromUrl(page.url());
    if (logNo) { const url = `https://blog.naver.com/${BLOG_ID}/${logNo}`; recordLedger({ slug, logNo, url, category, title: post.title, date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()) }); console.log(`PUBLISHED → ${url}`); }
    else console.log('published? url=', page.url());
  });
}

async function doEdit(logNo, file, categoryOverride, imageOverride, tagsOverride) {
  const post = loadPost(file);
  const slug = slugFromFile(file) || file;
  const category = categoryOverride || DEFAULT_CATEGORY;
  const canonicalUrl = canonicalLink(file);
  const image = coverImage(file, imageOverride);
  console.log(`edit ${logNo}: ${post.title} → ${category}`);
  return withBrowser(async () => {
    await page.goto(`https://blog.naver.com/PostWriteForm.naver?blogId=${BLOG_ID}&logNo=${logNo}&redirect=Update`, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(7000);
    frame = page.frames().find((f) => /PostWriteForm/i.test(f.url())) || page.mainFrame();
    await dismissDraftAlert();
    // clear title (macOS: select-all = Meta+A, NOT Control+A which is line-start)
    await frame.locator('.se-documentTitle .se-text-paragraph, .se-section-documentTitle .se-text-paragraph').first().click();
    await page.keyboard.press('Meta+A'); await page.keyboard.press('Backspace'); await page.waitForTimeout(300);
    await type(post.title); await page.waitForTimeout(300);
    // clear body (Meta+A twice = whole document, then delete), verify emptied
    await frame.locator('.se-component.se-text .se-text-paragraph').first().click();
    await page.keyboard.press('Meta+A'); await page.waitForTimeout(150);
    await page.keyboard.press('Meta+A'); await page.waitForTimeout(150);
    await page.keyboard.press('Backspace'); await page.waitForTimeout(700);
    const remain = await frame.evaluate(() => document.querySelectorAll('.se-component').length);
    if (remain > 2) { // still has old components → select-all again
      await frame.locator('.se-component.se-text .se-text-paragraph, .se-component .se-text-paragraph').first().click();
      await page.keyboard.press('Meta+A'); await page.waitForTimeout(150);
      await page.keyboard.press('Meta+A'); await page.waitForTimeout(150);
      await page.keyboard.press('Backspace'); await page.waitForTimeout(700);
    }
    console.log('  body components after clear:', await frame.evaluate(() => document.querySelectorAll('.se-component').length));
    await renderBody(post.body, image, canonicalUrl);
    await page.screenshot({ path: dataPath('tmp/naver-edit-filled.png'), fullPage: true });
    await publishPopup(category, resolveTags(file, tagsOverride));
    if (DRY) { console.log('--dry: not updating'); return; }
    await frame.locator('button[class*="confirm_btn__"]').first().click();
    await page.waitForTimeout(6000);
    const url = `https://blog.naver.com/${BLOG_ID}/${logNo}`;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
    recordLedger({ slug, logNo, url, category, title: post.title, date: today, editedAt: new Date().toISOString() });
    console.log(`EDITED (same logNo) → ${url}`);
  });
}

async function doDelete(logNo) {
  return withBrowser(async () => {
    // Owner delete: the post's 삭제 link is `a._deletePost` (`_param(<logNo>|..)`), hidden
    // in a menu, so a Playwright visibility-gated click times out. Fire its Naver handler
    // in-page instead → confirm dialog ("삭제된 글은 복구할 수 없습니다") auto-accepted by
    // withBrowser → POST /PostDelete.naver removes the post.
    let deletedAlert = false;
    page.on('dialog', (d) => { if (/삭제되었거나|존재하지 않/.test(d.message())) deletedAlert = true; });
    await page.goto(`https://blog.naver.com/${BLOG_ID}/${logNo}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    const fr = page.frames().find((f) => /PostView/i.test(f.url())) || page.mainFrame();
    const has = await fr.evaluate(() => !!document.querySelector('a._deletePost')).catch(() => false);
    if (!has) throw new Error(`delete link not found (logNo ${logNo}: not the owner / already deleted / does not exist)`);
    await fr.evaluate(() => document.querySelector('a._deletePost').click());
    await page.waitForTimeout(4000);
    // verify: reloading a deleted post fires the "삭제되었거나" alert
    await page.goto(`https://blog.naver.com/${BLOG_ID}/${logNo}`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const gone = deletedAlert || new RegExp(`/${BLOG_ID}$|blog\\.naver\\.com/?$`).test(page.url());
    const l = readLedger().filter((e) => e.logNo !== logNo);
    writeFileSync(LEDGER, JSON.stringify(l, null, 2) + '\n');
    console.log(gone ? `DELETED ${logNo} (verified)` : `delete clicked for ${logNo} (verify on the blog recommended)`);
  });
}

// ---------- dispatch ----------
const excludesValueOf = ['--category', '--image', '--tags'];
const editIdx = argv.indexOf('--edit');
const delId = flag('--delete');
if (editIdx !== -1) {
  const logNo = argv[editIdx + 1];
  const file = argv.filter((a, i) => !a.startsWith('--') && i !== editIdx + 1 && !(i > 0 && excludesValueOf.includes(argv[i - 1])))[0];
  if (!logNo || !file) { console.error('usage: post-api.mjs --edit <logNo> <file> [--category "..."] [--image <path>] [--tags "a,b,c"]'); process.exit(1); }
  await doEdit(logNo, file, flag('--category'), flag('--image'), flag('--tags'));
} else if (delId) {
  await doDelete(delId);
} else {
  const file = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && excludesValueOf.includes(argv[i - 1])))[0];
  if (!file) { console.error('usage: post-api.mjs <file> [--category "..."] [--image <path>] [--tags "a,b,c"] [--dry]'); process.exit(1); }
  await doPublish(file, flag('--category'), flag('--image'), flag('--tags'));
}
