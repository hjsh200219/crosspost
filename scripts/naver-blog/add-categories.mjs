// Add Naver blog categories (게시판) — one-time (idempotent) setup helper.
// Legacy AdminCategoryView editor. Verified mechanics:
//   - Category names must be set with fill() (clears cleanly); keyboard.type mangles
//     Korean + leaves the default "게시판" residue.
//   - "카테고리 추가" adds a SIBLING of the currently-selected node. To keep every new
//     category top-level, select the top-level "카테고리 전체보기" node BEFORE each add —
//     otherwise each new node nests under the previously-added one.
//   - One "확인" (#submit_button) saves the whole tree.
//   - "카테고리 추가" is an <img> (no innerText), so the editor frame is detected by URL
//     (AdminCategoryView) / the "카테고리명" label text.
//
//   node add-categories.mjs "카테고리1" "카테고리2" ...   # add missing categories, then save
//   node add-categories.mjs --dry "카테고리1" ...          # add in UI + screenshot, DO NOT save
//   NAVER_BLOG_CATEGORIES="a,b,c" node add-categories.mjs  # categories via env instead of argv
import { connect, acquirePage, releasePage } from './cdp.mjs';
import { loadEnv, dataPath } from '../lib/env.mjs';

loadEnv();

const BLOG_ID = process.env.NAVER_BLOG_ID;
if (!BLOG_ID) { console.error('NAVER_BLOG_ID not set in $CROSSPOST_HOME/.env'); process.exit(1); }
const DRY = process.argv.includes('--dry');
const argTopics = process.argv.slice(2).filter((a) => a !== '--dry');
const TOPICS = argTopics.length ? argTopics : (process.env.NAVER_BLOG_CATEGORIES || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!TOPICS.length) { console.error('usage: add-categories.mjs "category1" "category2" ... (or set NAVER_BLOG_CATEGORIES)'); process.exit(1); }

const { browser, ctx } = await connect();
const page = await acquirePage(ctx);
page.on('dialog', (d) => { console.log('  dialog:', d.message().slice(0, 60)); d.accept().catch(() => {}); });

const catFrame = async () => {
  for (let i = 0; i < 15; i++) {
    for (const f of page.frames()) {
      if (/AdminCategoryView/i.test(f.url()) ||
          await f.evaluate(() => document.body && /카테고리명|카테고리 관리/.test(document.body.innerText)).catch(() => 0)) return f;
    }
    await page.waitForTimeout(1000);
  }
  return null;
};
// Existing top-level category names (strip the trailing "(count)").
const readNames = (frame) => frame.evaluate(() => {
  const names = new Set();
  const re = /([^\s()][^()]{0,24})\((\d+)\)/g;
  let m; const txt = document.body.innerText;
  while ((m = re.exec(txt))) names.add(m[1].trim());
  return [...names];
});

try {
  await page.goto(`https://admin.blog.naver.com/AdminMain.naver?blogId=${BLOG_ID}&Redirect=Categoryinfo`, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(5000);
  const frame = await catFrame();
  if (!frame) throw new Error('category editor frame not found');

  const have = new Set(await readNames(frame));
  console.log('existing categories:', [...have].join(' | '));
  const toAdd = TOPICS.filter((t) => !have.has(t));
  console.log('to add:', toAdd.join(' | ') || '(none — all present)');
  if (!toAdd.length) { console.log('all requested categories already exist.'); process.exit(0); }

  for (const name of toAdd) {
    // Select the ROOT "카테고리 전체보기" before each add so the new category is TOP-LEVEL.
    // (Selecting a real node like 게시판 makes "카테고리 추가" create a SUB-category under it.)
    await frame.locator('text=카테고리 전체보기').first().click().catch(() => {});
    await page.waitForTimeout(400);
    await frame.locator('img._addCategoryView').first().click();
    await page.waitForTimeout(700);
    const input = frame.locator('#category_name');
    await input.fill(name); // clears + sets cleanly
    await frame.evaluate(() => {
      const el = document.querySelector('#category_name');
      for (const t of ['input', 'keyup', 'change', 'blur']) el.dispatchEvent(new Event(t, { bubbles: true }));
    });
    await frame.evaluate(() => { const r = document.querySelector('#pub_c1'); if (r && !r.checked) r.click(); }).catch(() => {});
    await page.waitForTimeout(400);
    console.log('  added:', name);
  }

  await page.screenshot({ path: dataPath('tmp/naver-cat-before-save.png'), fullPage: true });
  console.log('screenshot: naver-cat-before-save.png');
  if (DRY) { console.log('--dry: NOT saving (확인/confirm click skipped)'); process.exit(0); }

  await frame.locator('#submit_button').click();
  await page.waitForTimeout(4000);
  console.log('saved (확인/confirm button clicked).');
} catch (e) {
  // exit(1)이 아니라 exitCode — finally의 releasePage/close가 돌아야 공유 CDP 탭이 안 샌다
  process.exitCode = 1;
  console.error('error:', e.message);
  await page.screenshot({ path: dataPath('tmp/naver-cat-err.png') }).catch(() => {});
} finally {
  await releasePage(page);
  await browser.close().catch(() => {});
}
