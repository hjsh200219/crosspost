#!/usr/bin/env node
// Brunch auto-follow — follow-back (people who follow you and you don't follow) and
// follow-likers (people who liked your recent articles).
//
// **Reading is browserless.** The follower/following list endpoints are public, so plain node
// fetch gets a 200 without a cookie or a browser:
//   GET https://api.brunch.co.kr/v2/subscription/user/@@<userId>/followers?listSize=20&subscribeNo=<cursor>&direction=down
//   GET https://api.brunch.co.kr/v2/subscription/user/@@<userId>/writers?…   (writers = following)
// Only a browser User-Agent is required. It looked otherwise for a while because the validity
// gate used `/v2/me`, which is genuinely in-page only (401 to every other client) — but that is
// your own private account data, not the subscription lists.
//
// Your own userId goes into `@@<userId>` in those URLs. Since `/v2/me` is in-page only, it comes
// from `BRUNCH_USER_ID` in .env, falling back to one CDP lookup.
//
// Follow WRITE — **an in-page click on the profile page's follow button.** The obvious endpoint
// (`POST /v1/subscription/user/follow?writerUserId=`) **answers 200 and creates no
// relationship**: after a 200 the target was absent from the following list, the candidate count
// was unchanged, and the following total never moved. This is the same shape as publishing,
// where a raw `POST /v1/article` silently no-ops and the editor UI click is what actually
// creates the article — Brunch puts writes behind a client step. Success is confirmed by
// re-querying the public list, never by the button's own label (client-side state is exactly
// what fooled the endpoint implementation).
//
// There is no known unfollow endpoint, so a real follow cannot be undone from here — split real
// runs with `--max`.
//
// follow-likers reads the per-article likes page's API:
//   GET https://api.brunch.co.kr/v1/likeit/users/<articleNo>?createTime=<cursor>
//     → data.list[] {userId, userName, profileId, myWriter, …} · data.totalCount · data.moreList
//   **`myWriter` = whether you already subscribe** — the same field follow-back uses.
// That endpoint 401s from node fetch and from curl, and only answers a curl_cffi request, so it
// goes through the Python sidecar `likeit_users.py` (see its docstring — it is the one non-Node
// process here, and it needs `pip3 install curl_cffi`). follow-back needs none of that.
//
// **Without --dry-run this really follows people from your account** (and only then is the CDP
// browser needed).
// explore (cold discovery) works here too, and browserlessly: the same public subscription lists
// answer for ANY user id, so a seed account's writers/followers can be read without a session.
// The catch is that `myWriter` is only filled for a cookie'd request — from here it reads false
// even for accounts you do subscribe to, so candidacy comes from a set difference against your
// own writers list instead.
//
// usage: node follow.mjs (--follow-back|--follow-likers|--follow-explore) [--dry-run] [--max N]
//        [--delay-min S] [--delay-max S] [--posts N]
//        explore only: [--seed <userId> …] [--seed-side following|followers]
//                      [--min-followers N] [--max-followers N]
// `--posts N` (likers mode) collects likers from the N most recent ledger articles (default 10).

import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { openBrunch, envFileCookie, persistCookie } from './cookie.mjs';
import { loadEnv, home, dataPath, cdpPort } from '../lib/env.mjs';
import { followedIds, parseFollowArgs, runFollows, warnRealRun } from '../lib/follow-core.mjs';
import { seedsFor, seedSideFor, interleaveBySeed } from '../lib/follow-seeds.mjs';

loadEnv();

const CHANNEL = 'brunch';
const DIR = path.dirname(new URL(import.meta.url).pathname);
const ENV_PATH = path.join(home(), '.env');
const PORT = cdpPort();
const PAGE_SIZE = 20;   // measured page size of the Brunch list API
const MAX_PAGES = 60;   // backstop (60 × 20 = 1200 accounts)
const API = 'https://api.brunch.co.kr';
const PUBLISHED = dataPath('ledgers/published-brunch.json'); // articles to read likers from
const execFileAsync = promisify(execFile);
// Even the public list endpoints 401 a request with no browser UA (same string as cookie.mjs).
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const READ_HEADERS = { 'User-Agent': UA, Referer: 'https://brunch.co.kr/', Accept: 'application/json, text/plain, */*' };
// DOM matchers, not user-facing copy — these are the labels Brunch renders. Translating them
// would break the click. Override for another interface language.
const BTN_FOLLOW = new RegExp(`^${process.env.BRUNCH_FOLLOW_LABEL || '팔로우'}$`);
const BTN_FOLLOWING = new RegExp(`^${process.env.BRUNCH_FOLLOWING_LABEL || '팔로잉'}$`);

function classify(status, text, label) {
  const fatal = status === 401 || status === 403 || status === 429;
  const err = new Error(`${label} HTTP ${status}: ${(text || '').slice(0, 160)}`);
  if (fatal) err.fatal = true;
  return err;
}

// --- reading (browserless): cursor-paginate the public subscription lists ---
// The list endpoints are public for ANY user id, not just your own — which is what makes the
// explore mode possible here without a browser.
async function fetchAllBrowserless(myUserId, kind, maxPages = MAX_PAGES) {
  const out = [];
  let cursor = '999999999999'; // first page: a very large value → newest first
  for (let i = 0; i < maxPages; i++) {
    const url = `${API}/v2/subscription/user/@@${myUserId}/${kind}?listSize=${PAGE_SIZE}&subscribeNo=${cursor}&direction=down`;
    let res;
    try { res = await fetch(url, { headers: READ_HEADERS }); }
    catch (e) { throw new Error(`${kind} list request failed: ${e.message}`); }
    if (res.status !== 200) throw classify(res.status, await res.text().catch(() => ''), `${kind} list`);
    let list;
    try { list = (await res.json())?.data?.list || []; } catch { throw new Error(`${kind} list returned unparseable data`); }
    out.push(...list);
    if (!list.length || list.length < PAGE_SIZE) break;
    cursor = list[list.length - 1].subscribeNo;
  }
  return out;
}

// env BRUNCH_USER_ID first (browserless), else one CDP `/v2/me` lookup.
async function resolveMyUserId() {
  if (process.env.BRUNCH_USER_ID) return process.env.BRUNCH_USER_ID;
  const idClient = await openBrunch({ envPath: ENV_PATH, port: PORT });
  const uid = idClient.me?.userId;
  await idClient.close();
  if (!uid) throw new Error('could not resolve your Brunch userId — set BRUNCH_USER_ID in .env, or log into Brunch in the CDP browser.');
  console.error(`  ↳ resolved userId via CDP /v2/me (${uid}) — put BRUNCH_USER_ID=${uid} in .env to stay browserless.`);
  return uid;
}

// --- follow WRITE (in-page button click). Opens CDP only for a real run. The button label is
//     not the proof — an authoritative browserless re-query is. ---
async function followUser(page, myUserId, userId) {
  await page.goto(`https://brunch.co.kr/@@${encodeURIComponent(userId)}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(3000);

  // Already following = the desired end state; clicking would unfollow (it is a toggle).
  if (await page.locator('button', { hasText: BTN_FOLLOWING }).count() > 0) return;

  // Click only when exactly one button matches. Zero or several means a render delay or a
  // structural change — retryable, so it is not recorded as a definitive refusal.
  const btn = page.locator('button', { hasText: BTN_FOLLOW });
  const n = await btn.count();
  if (n !== 1) throw new Error(`follow ${userId}: matched ${n} follow buttons — cannot identify the target (render delay or layout change)`);
  await btn.first().click();
  await page.waitForTimeout(3000);

  const check = await fetchAllBrowserless(myUserId, 'writers').catch(() => []);
  if (!check.some((u) => u.userId === userId)) {
    const err = new Error(`follow ${userId}: button clicked but the target is absent from the following list`);
    err.unconfirmed = true;
    throw err;
  }
}

// Read the api.brunch.co.kr cookies straight out of the CDP context (no page render).
async function captureCookieFromCDP() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { noDefaults: true });
  try {
    const cookies = await browser.contexts()[0].cookies('https://api.brunch.co.kr');
    if (!cookies.length) throw new Error('no Brunch cookies in the CDP browser — log into Kakao there first');
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } finally {
    await browser.close().catch(() => {});
  }
}

// --- likers: delegated to the Python sidecar (see its docstring for why) ---
// The cookie goes through a temp file — passing it in argv would expose the session in `ps`.
async function likerUsersViaSidecar(cookie, articleNos) {
  const tmp = path.join(os.tmpdir(), `brunch-cookie-${process.pid}-${Date.now()}.txt`);
  writeFileSync(tmp, cookie, { mode: 0o600 });
  try {
    const { stdout } = await execFileAsync(
      'python3',
      [path.join(DIR, 'likeit_users.py'), '--cookie-file', tmp, '--articles', ...articleNos],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout);
    if (!parsed.ok) throw new Error(parsed.error || 'sidecar failed');
    return parsed;
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error('python3 not found — Brunch follow-likers needs python3 with curl_cffi (pip3 install curl_cffi). follow-back needs neither.');
    }
    throw e;
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

// Liker candidates from the most recent --posts articles.
// Candidacy is `myWriter === false` (not subscribed yet) — the same field follow-back reads.
async function likerCandidates(postCount) {
  let ledger = [];
  if (existsSync(PUBLISHED)) {
    try { ledger = JSON.parse(readFileSync(PUBLISHED, 'utf8')); } catch { ledger = []; }
  }
  const seen = new Set();
  const articleNos = [];
  for (const e of [...ledger].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))) {
    if (!e?.articleNo || seen.has(e.articleNo)) continue; // the ledger can hold an article twice
    seen.add(e.articleNo);
    articleNos.push(String(e.articleNo));
    if (articleNos.length >= postCount) break;
  }
  if (!articleNos.length) return [];

  // Cookie: env first (browserless) → on an all-401 result, re-capture over CDP and retry once.
  //
  // **Deliberately not cookie.mjs's `getCookie`.** Its validity gate is `/v2/me`, which is
  // in-page only, so it rejects every browserless cookie — the same misreading this file's
  // header documents. Validate with the endpoint actually being used instead.
  let cookie = envFileCookie(ENV_PATH);
  let result = cookie ? await likerUsersViaSidecar(cookie, articleNos).catch((e) => {
    if (/python3 not found|curl_cffi/.test(e.message)) throw e; // a missing dependency is not an auth problem
    return null;
  }) : null;
  const allAuthFailed = (r) => r && r.articles.length === 0 && (r.errors || []).length > 0
    && r.errors.every((e) => /HTTP 401/.test(e.message));
  if (!result || allAuthFailed(result)) {
    cookie = await captureCookieFromCDP();
    persistCookie(cookie, ENV_PATH);
    console.error('  ↳ re-captured the cookie over CDP and retried — later runs are browserless again');
    result = await likerUsersViaSidecar(cookie, articleNos);
  }
  const { articles, errors } = result;
  for (const err of errors || []) console.error(`  ↳ [skip] article ${err.articleNo}: ${err.message}`);

  const byId = new Map();
  let totalLikes = 0;
  for (const a of articles) {
    totalLikes += a.totalCount || 0;
    for (const u of a.users || []) {
      if (!u.userId || byId.has(u.userId)) continue;
      byId.set(u.userId, { userId: u.userId, userName: u.userName || u.userId, myWriter: !!u.myWriter, srcPost: a.articleNo });
    }
  }
  console.error(
    `  ↳ read ${articles.length}/${articleNos.length} articles · ${totalLikes} likes · ` +
    `${byId.size} unique likers`,
  );
  return [...byId.values()];
}

// --- explore: mine a seed account's neighbourhood ---
// Three pages per seed. Paginating a seed with thousands of subscribers to the end would spend
// minutes to produce candidates that `--max 3` discards anyway.
const EXPLORE_SEED_PAGES = 3;

async function exploreCandidates(seedList, side, myWriterSet, myUserId, { minFollowers, maxFollowers }) {
  const kind = side === 'following' ? 'writers' : 'followers'; // Brunch's word for "following"
  const bySeed = new Map();
  for (const seed of seedList) {
    let list;
    try { list = await fetchAllBrowserless(seed.id, kind, EXPLORE_SEED_PAGES); } catch (e) {
      console.error(`  ↳ [skip] seed @@${seed.id}: ${e.message}`);
      if (e.fatal) throw e;
      continue;
    }
    const kept = [];
    for (const u of list) {
      if (!u.userId || u.userId === myUserId) continue;
      // **Do not trust `myWriter` here.** The field only gets filled for a cookie'd request, and
      // these reads are browserless — it comes back false even for writers you do subscribe to.
      // The authoritative answer is the set difference against your own writers list.
      if (myWriterSet.has(u.userId)) continue;
      const followers = u.followerCount ?? 0;
      if (followers < minFollowers || followers > maxFollowers) continue;
      // No articles means there is nothing to subscribe to. Empty accounts are most of what the
      // `followers` side of a large seed returns.
      if ((u.articleCount ?? 0) < 1) continue;
      kept.push({ targetId: u.userId, handle: u.userName || u.userId, seed: seed.id });
    }
    console.error(`  ↳ seed @@${seed.id}/${kind}: ${list.length} read · ${kept.length} candidate(s)`);
    bySeed.set(seed.id, kept);
  }
  if (!bySeed.size) throw new Error('every seed failed to load — nothing was explored (this is not "no candidates").');
  return interleaveBySeed(bySeed);
}

const describe = (c) => `${c.handle} (${c.targetId})${c.seed ? ` [seed @@${c.seed}]` : ''}`;

async function main() {
  const { mode, dryRun, max, delayMin, delayMax, posts, seeds, seedSide, minFollowers, maxFollowers } =
    parseFollowArgs(process.argv, { explore: true });

  // 1) own userId + candidates — browserless in every mode. A dry run ends here, no CDP.
  const myUserId = await resolveMyUserId();
  const ledgerIds = followedIds(CHANNEL);

  let via, candidates;
  if (mode === 'explore') {
    via = 'explore';
    const side = seedSideFor(CHANNEL, seedSide);
    const seedList = seedsFor(CHANNEL, seeds);
    const myWriters = await fetchAllBrowserless(myUserId, 'writers');
    const myWriterSet = new Set(myWriters.map((u) => u.userId));
    console.error(`  ↳ ${seedList.length} seed(s) · side=${side} · excluding ${myWriterSet.size} you already follow`);
    candidates = (await exploreCandidates(seedList, side, myWriterSet, myUserId, { minFollowers, maxFollowers }))
      .filter((c) => !ledgerIds.has(c.targetId));
  } else if (mode === 'follow-back') {
    via = 'follow-back';
    const followers = await fetchAllBrowserless(myUserId, 'followers');
    const followings = await fetchAllBrowserless(myUserId, 'writers');
    console.error(`  ↳ followers=${followers.length} following=${followings.length} (browserless)`);
    const followingSet = new Set(followings.map((u) => u.userId));
    candidates = followers
      .filter((u) => !followingSet.has(u.userId) && !ledgerIds.has(u.userId))
      .map((u) => ({ targetId: u.userId, handle: u.userName || u.userId }));
  } else {
    via = 'liker';
    const likers = await likerCandidates(posts);
    const already = likers.filter((u) => u.myWriter).length;
    candidates = likers
      .filter((u) => !u.myWriter && u.userId !== myUserId && !ledgerIds.has(u.userId))
      .map((u) => ({ targetId: u.userId, handle: u.userName, srcPost: u.srcPost }));
    console.error(`  ↳ ${already} liker(s) already subscribed (myWriter=true) excluded`);
  }

  // 2) dry run or no candidates → nothing is written and the browser is never opened.
  if (dryRun || candidates.length === 0) {
    await runFollows({ channel: CHANNEL, candidates, via, dryRun, max, delayMin, delayMax, follow: () => { throw new Error('unreachable'); }, describe });
    return;
  }

  // 3) real follows — only now open the CDP browser and click in-page.
  warnRealRun(
    CHANNEL,
    'Brunch has no unfollow endpoint here, so a follow cannot be undone by this tool.' +
    (via === 'explore' ? ' These are cold candidates with no prior connection to you — split the run with --max.' : ''),
  );
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { noDefaults: true });
  try {
    const ctx = browser.contexts()[0];
    const page = ctx.pages().find((p) => p.url().includes('brunch.co.kr')) || ctx.pages()[0] || (await ctx.newPage());
    await page.bringToFront();
    if (!page.url().includes('brunch.co.kr')) {
      await page.goto('https://brunch.co.kr', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1000);
    }
    await runFollows({
      channel: CHANNEL,
      candidates,
      via,
      dryRun,
      max,
      delayMin,
      delayMax,
      follow: (uid) => followUser(page, myUserId, uid),
      describe,
    });
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
