#!/usr/bin/env node
// Naver Blog auto-follow — follow-back only (people who added you as a neighbour while you have
// not added them). Reading is browserless: the admin pages answer a cookie'd request directly,
// the same finding stats.mjs rests on (CORS only exists in a browser). Auth reuses
// resolveCookie() with the same cookie set as stats.mjs.
//
// Candidates: GET https://admin.blog.naver.com/BuddyMeManage.naver?blogId=<BLOG_ID> lists the
// people who added you; the HTML carries `addBuddyPop('<blogId>', …)` calls. A row can render
// two buttons for the same blogId, so the ids are deduped.
//
// **That list is not the candidate set by itself.** BuddyMeManage renders the same button for
// people who are ALREADY your neighbours, and their popup is a *settings* screen (switch to
// mutual / cancel), not an add screen — its `relation` radios offer 1 and -1 but no 0. Without
// subtracting your existing neighbours those people stay candidates forever and every run burns
// a pointless write on them. So the candidate list is the difference against BuddyListManage.
//
// **BuddyListManage is paginated at 50 per page** and needs `currentPage` — reading only the
// first page reports everyone past the 50th as "not a neighbour", which silently turns into
// false failures in the confirmation step.
//
// Follow WRITE — three form POSTs to blog.naver.com/BuddyAdd.naver, no browser required. The
// token in that flow is NOT a server-issued CSRF token: the page's own JS generates a random
// Uint32 and passes it through the URL fragment (which never reaches the server), so it is a
// double-submit nonce and `crypto.randomInt` reproduces it. `--cdp` keeps the old popup-driving
// path. Either way `relation` is pinned to 0 (one-way neighbour) — 1 is a mutual-neighbour
// REQUEST and must never be sent by accident.
//
// **A success message in the popup is not proof.** A real run once printed "no success text"
// for two targets while one of them had in fact been added. Confirmation is a re-read of
// BuddyListManage; if the id is absent the write is recorded `unconfirmed` (a human checks it —
// it is neither retried automatically nor counted as followed).
//
// follow-likers is **structurally impossible here**: the reaction widget's `_faceLayer` is a
// reaction-TYPE picker, not a list of people; the like service's `/users` and
// `/reactions/like/users` answer `errorCode 4044` (**HTTP 200 with an error body**, so checking
// the status alone reads as success); and BlogNotificationList is the Naver blog team's notices,
// not your notifications. This is `✗` (no such surface), not "no data".
//
// ⚠️ While investigating that, clicking the like COUNT toggled a like on our own post — the
// count span sits inside the like button. The same trap exists on other channels: **a count is
// usually part of a toggle, not a link to a list.** Investigate liker surfaces by navigation and
// network capture, not by clicking.
//
// usage: node follow.mjs (--follow-back|--follow-likers) [--dry-run] [--max N]
//        [--delay-min S] [--delay-max S] [--cdp]

import crypto from 'node:crypto';
import path from 'node:path';
import { chromium } from 'playwright';
import { resolveCookie } from '../lib/site-cookie.mjs';
import { connect, acquirePage, releasePage } from './cdp.mjs';
import { loadEnv, home, cdpPort } from '../lib/env.mjs';
import { followedIds, parseFollowArgs, runFollows, warnRealRun } from '../lib/follow-core.mjs';

loadEnv();

const CHANNEL = 'naver-blog';
const ENV_PATH = path.join(home(), '.env');
const PORT = cdpPort();
const BLOG_ID = process.env.NAVER_BLOG_ID;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const COOKIE_NAMES = ['NID_AUT', 'NID_SES', 'NID_JST', 'NNB'];
const MAX_BUDDY_PAGES = 40; // 50 per page — backstop against a response that never stops giving

// Every neighbour you have added, as a Set of blogIds. Pagination is mandatory (see header).
// Row shape: <a href="https://blog.naver.com/<blogId>" target="_blank">…</a> — a path, not a
// `blogId=` query, so a `blogId=` regex matches nothing here.
async function fetchExistingBuddies(cookie) {
  const ids = new Set();
  for (let page = 1; page <= MAX_BUDDY_PAGES; page++) {
    const url = `https://admin.blog.naver.com/BuddyListManage.naver?blogId=${BLOG_ID}&currentPage=${page}`;
    const res = await fetch(url, { headers: { cookie, 'user-agent': UA, referer: 'https://admin.blog.naver.com/' } });
    if (!res.ok) throw new Error(`BuddyListManage.naver HTTP ${res.status} (page=${page})`);
    const html = await res.text();
    const before = ids.size;
    for (const m of html.matchAll(/href="https:\/\/blog\.naver\.com\/([A-Za-z0-9_-]+)"/g)) {
      if (m[1] !== BLOG_ID) ids.add(m[1]);
    }
    // An empty first page is a read failure, not "zero neighbours". Returning an empty set would
    // resurrect every existing neighbour as a candidate and make the confirmation step call
    // every write a failure — a confidently wrong helper, which is the exact failure this
    // pagination fix exists to prevent.
    if (page === 1 && ids.size === 0) {
      throw new Error('BuddyListManage.naver returned no neighbours on page 1 — treating it as a read failure rather than "zero neighbours"');
    }
    // Past the last page no new ids arrive.
    if (ids.size === before) return ids;
    if (page === MAX_BUDDY_PAGES) {
      console.error(`  ↳ warning: the neighbour list was cut off at ${MAX_BUDDY_PAGES} pages — there may be more.`);
    }
  }
  return ids;
}

async function fetchAddBuddyCandidates(cookie) {
  const url = `https://admin.blog.naver.com/BuddyMeManage.naver?blogId=${BLOG_ID}`;
  const res = await fetch(url, { headers: { cookie, 'user-agent': UA, referer: 'https://admin.blog.naver.com/' } });
  if (!res.ok) throw new Error(`BuddyMeManage.naver HTTP ${res.status}`);
  const html = await res.text();

  // Say so when the response looks paginated — this reads page 1 only, and it truncates nothing
  // silently.
  if (/(?:page|pageNum|curPage)=\d+/i.test(html) || /totalCount['"]?\s*[:=]\s*\d+/i.test(html) || /<div[^>]*paging[^>]*>/i.test(html)) {
    console.error('  ↳ warning: the response looks paginated — only page 1 was read, so there may be more candidates.');
  }

  const raw = [...html.matchAll(/addBuddyPop\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const seen = new Set();
  const ids = [];
  for (const id of raw) {
    if (id === BLOG_ID || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  const existing = await fetchExistingBuddies(cookie);
  const fresh = ids.filter((id) => !existing.has(id));
  console.error(`  ↳ excluded ${existing.size} existing neighbour(s) → candidates ${ids.length} → ${fresh.length}`);
  return fresh;
}

// The only authoritative confirmation. Scans every page — checking page 1 alone turns every
// neighbour past the 50th into a false failure.
async function confirmAdded(cookie, blogId) {
  return (await fetchExistingBuddies(cookie)).has(blogId);
}

const makeToken = () => String(crypto.randomInt(0, 2 ** 32)); // same Uint32 nonce the page makes

// Collect the first form's hidden/checked inputs from a response. The third-stage form is rarely
// observed, so its fields are echoed back rather than guessed at.
function parseFormFields(html) {
  const fields = {};
  for (const m of html.matchAll(/<input\b[^>]*>/g)) {
    const tag = m[0];
    const name = (tag.match(/name=["']([^"']+)["']/) || [])[1];
    if (!name) continue;
    const type = ((tag.match(/type=["']([^"']+)["']/) || [])[1] || 'text').toLowerCase();
    const value = (tag.match(/value=["']([^"']*)["']/) || [])[1] ?? '';
    if (type === 'radio' || type === 'checkbox') {
      if (/\bchecked\b/.test(tag)) fields[name] = value;
    } else {
      fields[name] = value;
    }
  }
  for (const m of html.matchAll(/<select\b[^>]*name=["']([^"']+)["'][\s\S]*?<\/select>/g)) {
    const sel = m[0];
    const opt = sel.match(/<option[^>]*\bselected\b[^>]*value=["']([^"']*)["']/)
      || sel.match(/<option[^>]*value=["']([^"']*)["']/);
    if (opt) fields[m[1]] = opt[1];
  }
  return fields;
}

function relationRadios(html) {
  return [...html.matchAll(/<input\b[^>]*name=["']relation["'][^>]*>/g)].map((m) => ({
    value: (m[0].match(/value=["']([^"']*)["']/) || [])[1],
    checked: /\bchecked\b/.test(m[0]),
  }));
}

async function followUserBrowserless(cookie, blogId) {
  const token = makeToken();
  const origin = 'https://admin.blog.naver.com';
  const headers = {
    cookie, 'user-agent': UA,
    referer: `https://admin.blog.naver.com/BuddyMeManage.naver?blogId=${BLOG_ID}`,
    'content-type': 'application/x-www-form-urlencoded',
  };
  const post = async (body, qs = '') => {
    const res = await fetch(`https://blog.naver.com/BuddyAdd.naver${qs}`, { method: 'POST', headers, body });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`BuddyAdd ${res.status}`);
    return text;
  };

  // 1) relation screen (no token needed yet)
  const step1 = await post('', `?blogId=${encodeURIComponent(blogId)}&trackingCode=buddy_who_added_me&check=false`);
  const radios = relationRadios(step1);
  if (!radios.length) throw new Error(`${blogId}: no relation radios — the screen structure probably changed`);
  // No 0 option = this is the settings screen, i.e. already a neighbour.
  if (!radios.some((r) => r.value === '0')) {
    console.error(`  ↳ ${blogId}: already a neighbour — settings screen, nothing sent`);
    return;
  }

  // 2) relation pinned to 0. Never leave it to the server preset: 1 is a mutual-neighbour request.
  const f1 = { ...parseFormFields(step1), blogId, token, origin, sympathy: 'false', relation: '0' };
  const step2 = await post(new URLSearchParams(f1).toString());

  // 3) group selection — some targets skip this screen entirely.
  if (/name=["']groupId["']/.test(step2)) {
    const f2 = { ...parseFormFields(step2), blogId, token, origin, relation: '0' };
    await post(new URLSearchParams(f2).toString());
  }
}

// The old popup path (`--cdp`): call addBuddyPop, wait for the popup, click "next" once or twice.
async function followUserInPage(page, cookie, blogId) {
  const popupPromise = page.waitForEvent('popup', { timeout: 8000 });
  await page.evaluate((id) => window.buddyMeManage.addBuddyPop(id, 'check=false'), blogId);
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  await popup.waitForSelector('a._buddyAddNext', { timeout: 8000 });

  // relation MUST be 0. An earlier implementation swallowed the "cannot find the radio" timeout
  // and went on to POST relation=1 — an unrequested mutual-neighbour REQUEST, which only failed
  // to complete because the next selector happened not to exist on that screen. Never swallow it.
  const radios = await popup.$$eval('input[name=relation]', (els) => els.map((e) => ({ value: e.value, checked: e.checked })));

  if (radios.length > 0 && !radios.some((r) => r.value === '0')) {
    await popup.close().catch(() => {});
    console.error(`  ↳ ${blogId}: already a neighbour — settings screen, nothing clicked`);
    return;
  }

  if (radios.length > 0 && !radios.some((r) => r.value === '0' && r.checked)) {
    await popup.check('input[name=relation][value="0"]', { timeout: 3000 }).catch(() => {});
    const now = await popup.$eval('input[name=relation]:checked', (el) => el.value).catch(() => null);
    if (now !== '0') {
      await popup.close().catch(() => {});
      throw new Error(`could not set relation back to one-way (currently ${now}) — stopping so no mutual request goes out`);
    }
  }

  await popup.click('a._buddyAddNext', { timeout: 5000 });
  await popup.waitForTimeout(1500);

  const groupNext = await popup.$('a._addBuddy');
  if (groupNext) {
    await groupNext.click({ timeout: 5000 });
    await popup.waitForTimeout(1500);
  }
  await popup.close().catch(() => {});

  if (!(await confirmAdded(cookie, blogId))) {
    const err = new Error(`${blogId}: not found in BuddyListManage on re-read — check by hand`);
    err.unconfirmed = true;
    throw err;
  }
}

const describe = (c) => `${c.handle} (${c.targetId})`;

async function main() {
  const { mode, dryRun, max, delayMin, delayMax } = parseFollowArgs(process.argv);

  if (!BLOG_ID) {
    console.error('NAVER_BLOG_ID is not set in $CROSSPOST_HOME/.env');
    process.exit(1);
  }

  if (mode === 'follow-likers') {
    console.log(
      'follow-likers is not possible on Naver Blog: the reaction widget exposes a reaction-type ' +
      'picker rather than a list of people, the like service\'s /users and /reactions/like/users ' +
      'return errorCode 4044 (HTTP 200 with an error body), and BlogNotificationList is the Naver ' +
      'blog team\'s notice feed. See this file\'s header.',
    );
    process.exit(0);
  }

  const { cookie, src } = await resolveCookie({
    key: 'NAVER_COOKIE',
    envPath: ENV_PATH,
    port: PORT,
    chromium,
    origins: ['https://blog.naver.com', 'https://admin.blog.naver.com', 'https://naver.com'],
    names: COOKIE_NAMES,
  });
  console.error(`cookie src: ${src}`);

  const blogIds = await fetchAddBuddyCandidates(cookie);
  console.error(`  ↳ follow-back candidates=${blogIds.length}`);

  const ledgerIds = followedIds(CHANNEL);
  const candidates = blogIds
    .filter((id) => !ledgerIds.has(id))
    .map((id) => ({ targetId: id, handle: id }));

  if (dryRun) {
    // Reading is entirely browserless — a dry run never opens the browser.
    await runFollows({ channel: CHANNEL, candidates, via: 'follow-back', dryRun, max, delayMin, delayMax, follow: async () => {}, describe });
    return;
  }

  if (candidates.length) {
    warnRealRun(CHANNEL, 'Each follow adds a one-way neighbour on your blog; the tool never sends mutual-neighbour requests.');
  }

  // Default path: browserless. The old popup path stays available as `--cdp` — a browserless
  // failure creates no relationship and is recorded `unconfirmed`, so retrying costs nothing.
  if (!process.argv.includes('--cdp')) {
    await runFollows({
      channel: CHANNEL, candidates, via: 'follow-back', dryRun, max, delayMin, delayMax,
      follow: async (blogId) => {
        await followUserBrowserless(cookie, blogId);
        if (!(await confirmAdded(cookie, blogId))) {
          const err = new Error(`${blogId}: the POSTs went through but BuddyListManage does not show it`);
          err.unconfirmed = true;
          throw err;
        }
      },
      describe,
    });
    return;
  }

  const { browser, ctx } = await connect();
  const page = await acquirePage(ctx);
  await page.bringToFront().catch(() => {});
  try {
    await page.goto(`https://admin.blog.naver.com/BuddyMeManage.naver?blogId=${BLOG_ID}`, { waitUntil: 'networkidle', timeout: 25000 });
    await runFollows({
      channel: CHANNEL,
      candidates,
      via: 'follow-back',
      dryRun,
      max,
      delayMin,
      delayMax,
      follow: (blogId) => followUserInPage(page, cookie, blogId),
      describe,
    });
  } finally {
    await releasePage(page);
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
