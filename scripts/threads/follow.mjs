#!/usr/bin/env node
// Threads auto-follow — follow-back (people who follow you and you don't follow) and
// follow-likers (people who liked your posts, partially recoverable — see below).
// Your own handle is derived from the logged-in session, never hardcoded: an account rename
// turns a hardcoded handle into a 404, and the follower collector reads that as "page structure
// changed", which kills follow-back while the likers mode (a session-relative `/activity` path)
// keeps working — so it does not even look like an account problem.
//
// ⚠️ Meta polices follow automation hard. Defaults here are therefore much more conservative
// than follow-core's — `--max 3` and a 90–300s delay — and a non-dry run prints a warning.
//
// Reading followers — the profile's "followers" count is a `div[role=button]`; clicking it opens
// a `[role=dialog]` modal that paginates the full follower list via `FollowersTabQuery` +
// `…FollowersTabRefetchableQuery`. Those GraphQL responses carry, per person, `pk`, `username`
// and `friendship_status:{followed_by, following, outgoing_request}`. The `/@<user>/followers`
// route is a hard 404 and the Graph API has no follower LIST endpoint (only a count), so driving
// the modal is the only path — the anti-abuse tokens are minted per page load, which is why the
// app's own request has to be intercepted rather than rebuilt.
//
// Candidates = followedBy && !following && !outgoingRequest. **`outgoing_request` matters**:
// without it, accounts you have already sent a request to stay candidates forever, and the run
// reports "no follow button" for every one of them (the button says "requested").
//
// Follow WRITE — the real button is clicked in-page. **Scope the click to the profile's action
// row**: take the "message" button and walk up to the first ancestor containing a follow-style
// button. Picking the first match in document order clicks a follow button belonging to
// **someone else's account in the post feed** — the click succeeds and the target never changes.
// Also note a follow-back target's button reads "follow back", not "follow".
//
// Confirmation reloads the profile and reads two signals, up to three attempts each: the Relay
// flags near that pk, and the action row's label **in the reloaded document** (that is a server
// response, not the optimistic render right after a click). A missing flag is `null` = "could
// not read", **not** "not following" — conflating those two produced false "unconfirmed" reports
// on follows that had in fact gone through. The two failure modes are reported differently:
// `not-followed` (a readable signal says no) vs `unreadable` (nothing could be read).
//
// follow-likers is **a partial recovery, and that limitation is not hidden**. Threads has no
// liker list: the `/likes` route falls back to the post page, and `/api/v1/media/<pk>/likers/`
// returns 200 with `{"users":[],"user_count":N}` — the count is right, the list is always empty
// (Instagram's identical-looking endpoint DOES return users; do not assume one transfers to the
// other). The only identity source is the activity feed, where a like story carries
// `"icon_name":"like"` plus the liker's pk/username. **Aggregated notifications name only one
// person** ("X and 6 others"), so a post with 56 likes yields one candidate. The run logs how
// many stories were aggregated so the number is never mistaken for a like count.
// Also: the like COUNT on a post is the heart toggle itself — clicking it likes the post. This
// file never clicks a post action row.
//
// explore (cold discovery) points the same follower collector at a seed account's profile — the
// followers modal is the only list surface Threads has, so `--seed-side following` is refused
// rather than silently answered with followers.
//
// usage: node follow.mjs (--follow-back|--follow-likers|--follow-explore) [--dry-run] [--max N]
//        [--delay-min S] [--delay-max S]
//        explore only: [--seed <handle> …] [--min-followers N] [--max-followers N]
//        node follow.mjs --verify <pk> <username>   # check a relationship, follow nothing
// Requires a logged-in threads.com session in the shared CDP browser.

import { chromium } from 'playwright';
import { loadEnv, cdpPort } from '../lib/env.mjs';
import { blockedIds, followedIds, parseFollowArgs, runFollows, warnRealRun } from '../lib/follow-core.mjs';
import { seedsFor, seedSideFor, interleaveBySeed } from '../lib/follow-seeds.mjs';

loadEnv();

const CHANNEL = 'threads';
const PORT = cdpPort();
const PROFILE_HANDLE = process.env.THREADS_HANDLE || null; // explicit override; else derived
const IG_APP_ID = process.env.IG_APP_ID || '238260118697367'; // the Threads web app id

// Derive your own handle from the session. The home nav's profile link is `/@<handle>`, so a
// rename is followed automatically. The label lives in **innerText, not aria-label** (both are
// read here, but do not merge candidate sources when diagnosing — that misreading cost a day).
// The nav mounts late in this SPA, so it polls.
async function resolveOwnHandle(page) {
  if (PROFILE_HANDLE) return PROFILE_HANDLE;
  await page.goto('https://www.threads.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
  let handle = null;
  for (let i = 0; i < 10 && !handle; i++) {
    await page.waitForTimeout(1000);
    handle = await page.evaluate(() => {
      const label = (a) => ((a.getAttribute('aria-label') || a.innerText || '').trim());
      const mine = [...document.querySelectorAll('a[href^="/@"]')]
        .find((a) => /^(프로필|Profile)$/.test(label(a)) && /^\/@[a-zA-Z0-9_.]+$/.test(a.getAttribute('href') || ''));
      return mine ? mine.getAttribute('href').slice(2) : null;
    });
  }
  if (!handle) {
    throw new Error('could not read your handle from the session — logged out, or the nav changed. Set THREADS_HANDLE to bypass.');
  }
  return handle;
}

// Nearest preceding value within the window (null when the order is not guaranteed).
function lastMatch(text, re) {
  const all = [...text.matchAll(re)];
  return all.length ? all[all.length - 1][1] : null;
}

function parseRelayUsers(html) {
  const re = /"pk":"(\d+)","text_post_app_is_private":(?:true|false|null),"username":"([a-zA-Z0-9_.]+)"/g;
  const hits = [...html.matchAll(re)];
  const out = new Map();
  for (let i = 0; i < hits.length; i++) {
    const m = hits[i];
    const [, pk, username] = m;
    const before = html.slice(Math.max(0, m.index - 300), m.index);
    // The follower count sits AFTER the username, so it is read from this record's own span —
    // from here to where the next user record starts. A fixed-width window would reach into the
    // neighbouring record and attribute somebody else's count, and that number is used as a
    // quality floor for cold follows.
    const span = html.slice(m.index, i + 1 < hits.length ? hits[i + 1].index : m.index + 4000);
    const fc = span.match(/"follower_count":(\d+)/);
    out.set(pk, {
      pk,
      username,
      following: lastMatch(before, /"following":(true|false)/g) === 'true',
      followedBy: lastMatch(before, /"followed_by":(true|false)/g) === 'true',
      outgoingRequest: lastMatch(before, /"outgoing_request":(true|false)/g) === 'true',
      followerCount: fc ? Number(fc[1]) : null,
    });
  }
  return [...out.values()];
}

// Open the followers modal and scroll it to the bottom, capturing the FollowersTab responses.
// Matching the visible count element matters: a text search also hits the Relay payload inside
// a <script>, which is not clickable and made an earlier attempt conclude there was no modal.
async function collectAllFollowers(page) {
  const bodies = [];
  const onResp = async (res) => {
    const req = res.request();
    const fn = req.headers()['x-fb-friendly-name']
      || (req.postData() || '').match(/fb_api_req_friendly_name=([^&]+)/)?.[1] || '';
    if (/FollowersTab/i.test(fn)) { try { bodies.push(await res.text()); } catch { /* body gone */ } }
  };
  page.on('response', onResp);
  try {
    const total = await page.evaluate(() => {
      const t = document.body.innerText || '';
      const m = t.match(/팔로워\s*([\d,]+)\s*명/) || t.match(/([\d,]+)\s+followers?/i);
      return m ? Number(m[1].replace(/,/g, '')) : null;
    });
    await page.getByText(/팔로워|followers/i).first().click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(2500);
    let prev = -1, stable = 0;
    for (let i = 0; i < 80 && stable < 3; i++) {
      const n = await page.evaluate(() => {
        const d = document.querySelector('[role=dialog]');
        if (!d) return 0;
        const scroller = [...d.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 40) || d;
        scroller.scrollTop = scroller.scrollHeight;
        return new Set([...d.querySelectorAll('a[href^="/@"]')].map((a) => a.getAttribute('href'))).size;
      });
      if (n <= prev) stable++; else { stable = 0; prev = n; }
      await page.waitForTimeout(1000);
    }
    const users = parseRelayUsers(bodies.join('\n'));

    // **Recovering nothing is a read failure, not "zero followers".** If the modal never opened,
    // `bodies` stays empty and this would return cleanly — the caller then reports
    // `candidates=0` and exits 0, which reads as "nobody to follow". The follower total is read
    // by a separate path, so it can arbitrate: a positive total with zero records means only the
    // collection failed. A genuinely empty account has total === 0 and is not caught here.
    if (users.length === 0) {
      if (total > 0) {
        throw new Error(`recovered no records from the followers modal (total=${total}) — treating it as a read failure; the modal may not have opened (retry).`);
      }
      if (total === null) {
        // Say "404" when it is a 404. A dead handle repeats forever, and calling that "structure
        // changed, retry" sends the reader hunting selectors instead of the URL.
        const notFound = await page.evaluate(() =>
          /이 페이지는 길을 잃었습니다|Sorry, this page isn't available/i.test(document.body.innerText || ''));
        if (notFound) {
          throw new Error(`the profile page 404s (${page.url()}) — the handle is invalid (renamed account?). Retrying will not help; set THREADS_HANDLE or check the handle resolution.`);
        }
        throw new Error('could not read the follower total or any modal record — page load or structure problem (retry).');
      }
    }
    // Partial recovery only warns: it costs candidates, it never touches the wrong target, and
    // the modal scroll is flaky enough that throwing would make the tool fail routinely.
    if (total > 0 && users.length < total * 0.5) {
      console.error(`  ↳ warning: recovered ${users.length}/${total} — the scroll may not have finished, so candidates can be missing (a re-run may find more).`);
    }
    return { users, total };
  } finally {
    page.off('response', onResp);
  }
}

// Like stories out of the activity feed, [{pk, username, srcPost, aggregated}].
function parseLikeStories(html) {
  const out = new Map();
  let aggregated = 0;
  for (const m of html.matchAll(/\{"node":\{"args":\{[\s\S]{0,20000}?"story_type":\d+/g)) {
    const story = m[0];
    if (!/"icon_name":"like"/.test(story)) continue; // more stable than the numeric story_type
    const who = story.match(/"profile_image_destination":"user\?id=(\d+)&username=([A-Za-z0-9_.]+)"/);
    if (!who) continue;
    const shortcode = story.match(/"destination":"media\?id=[^"&]*&shortcode=([A-Za-z0-9_-]+)/)?.[1] || null;
    // "X and N others" = an aggregated story; only one person is in the JSON.
    // **The title is `\uXXXX`-escaped in the document** — matching the decoded text directly
    // finds nothing and reports zero aggregation.
    const title = story.match(/"title":"((?:[^"\\]|\\.)*)"/)?.[1] || '';
    const decoded = title.replace(/\\u([0-9a-fA-F]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16)));
    const agg = /외 \d+\s*명|and \d+ others/.test(decoded);
    if (agg) aggregated++;
    const [, pk, username] = who;
    if (!out.has(pk)) out.set(pk, { pk, username, srcPost: shortcode, aggregated: agg });
  }
  return { users: [...out.values()], aggregated };
}

// Scroll the activity feed and read the stories embedded in the document. No clicking — a
// notification click navigates, and mis-clicking an action row is the trap this file avoids.
async function collectLikeActivity(page, maxScrolls = 30) {
  await page.goto('https://www.threads.com/activity', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3500);
  let prev = -1, stable = 0;
  let best = { users: [], aggregated: 0 };
  for (let i = 0; i < maxScrolls && stable < 3; i++) {
    const parsed = parseLikeStories(await page.content());
    if (parsed.users.length > best.users.length) best = parsed;
    if (parsed.users.length <= prev) stable++; else { stable = 0; prev = parsed.users.length; }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);
  }
  return best;
}

// One candidate's current relationship. threads.com keeps Instagram's friendships/show.
// A failed read returns null — never fold "could not read" into "no relationship", or the tool
// fires a write at someone it already follows.
async function friendship(page, pk, appId) {
  return page.evaluate(async ({ pk, appId }) => {
    try {
      const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
      const res = await fetch(`/api/v1/friendships/show/${pk}/`, {
        credentials: 'include',
        headers: { 'x-ig-app-id': appId, 'x-csrftoken': csrf, 'x-requested-with': 'XMLHttpRequest' },
      });
      if (res.status !== 200) return null;
      const j = await res.json();
      return { following: !!j.following, followedBy: !!j.followed_by, outgoingRequest: !!j.outgoing_request };
    } catch { return null; }
  }, { pk, appId });
}

// Relay flags nearest to that pk in a freshly loaded document. `null` = could not read.
function findFollowingNear(html, pk) {
  const idx = html.indexOf(`"pk":"${pk}"`);
  if (idx < 0) return null;
  const before = html.slice(Math.max(0, idx - 500), idx);
  const following = [...before.matchAll(/"following":(true|false)/g)].pop();
  const outgoing = [...before.matchAll(/"outgoing_request":(true|false)/g)].pop();
  return {
    following: following ? following[1] === 'true' : null,
    outgoingRequest: outgoing ? outgoing[1] === 'true' : null,
  };
}

const VERIFY_ATTEMPTS = 3; // a parse miss is usually a hydration timing problem

// Two signals, symmetric in both directions: the reloaded document's action row confirms a
// follow ("following"/"requested") AND confirms a non-follow ("follow"/"follow back"), so a pk
// whose flags cannot be found is still decidable. No early exit — the graph can take a moment
// to propagate right after a click, and deciding on attempt 1 is the false-negative this guards.
async function verifyFollowed(page, pk) {
  let last = { flags: null, row: null, rowState: null };
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
    await page.reload({ waitUntil: 'networkidle', timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const flags = findFollowingNear(await page.content(), pk);
    if (flags?.following === true || flags?.outgoingRequest === true) {
      return { ok: true, via: `Relay flags (attempt ${attempt})` };
    }
    const row = await readActionRow(page, false).catch(() => null);
    if (row?.state === 'already') {
      return { ok: true, via: `reloaded button "${row.label}" (attempt ${attempt})` };
    }
    last = { flags, row: row?.label || row?.state || null, rowState: row?.state || null };
  }
  const flagsReadable = last.flags && (last.flags.following !== null || last.flags.outgoingRequest !== null);
  const decided = last.rowState === 'pending' || flagsReadable;
  return { ok: false, reason: decided ? 'not-followed' : 'unreadable', last };
}

// Read the profile action row. `doClick=false` is observation only, so the verification step
// reuses the same selector logic — a separate verification selector is how one of them ends up
// fixed and the other not. States: no-row · already · not-found · clicked · pending.
async function readActionRow(page, doClick) {
  return await page.evaluate((doClick) => {
    // DOM matchers, not user-facing copy: these are the labels Threads renders.
    const FOLLOW = ['맞팔로우', '팔로우', 'Follow back', 'Follow'];
    const DONE = ['팔로잉', '요청함', 'Following', 'Requested'];
    const MSG = ['메시지 보내기', 'Message'];
    const txt = (b) => (b.textContent || '').trim();
    const btns = [...document.querySelectorAll('div[role=button]')];

    // Scope to the profile action row: from the message button, walk up to the first ancestor
    // that contains a follow-style button. Taking document order instead clicks a follow button
    // belonging to someone else's account in the post feed.
    const msg = btns.find((b) => MSG.includes(txt(b)));
    let row = null;
    for (let el = msg; el && el !== document.body; el = el.parentElement) {
      const hit = [...el.querySelectorAll('div[role=button]')].filter((b) => FOLLOW.includes(txt(b)) || DONE.includes(txt(b)));
      if (hit.length) { row = hit; break; }
    }
    if (!row) return { state: 'no-row', seen: btns.map(txt).filter((t) => t && t.length <= 12).slice(0, 20) };

    const done = row.find((b) => DONE.includes(txt(b)));
    if (done) return { state: 'already', label: txt(done) };
    const target = row.find((b) => FOLLOW.includes(txt(b)));
    if (!target) return { state: 'not-found', seen: row.map(txt) };
    const label = txt(target);
    if (doClick) target.click();
    return { state: doClick ? 'clicked' : 'pending', label };
  }, doClick);
}

async function followUser(page, pk, username) {
  await page.goto(`https://www.threads.com/@${username}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(2000);
  const state = await readActionRow(page, true);

  if (state.state === 'no-row') {
    throw new Error(`@${username}: could not find the profile action row (structure change?). buttons=${JSON.stringify(state.seen)}`);
  }
  if (state.state === 'not-found') {
    // The row rendered but holds no follow-style button, and 'already' was ruled out above — so
    // this target cannot be followed from here (the same shape as a Facebook profile with a
    // pending friend request). Retrying gets the same answer, so it is recorded `blocked`.
    // Do not confuse this with 'no-row' above, which is a render/structure problem worth
    // retrying: collapsing the two makes one flaky render exclude a good target forever.
    const err = new Error(`@${username}: no follow-style button in the action row (relationship state does not allow following). buttons=${JSON.stringify(state.seen)}`);
    err.blocked = true;
    throw err;
  }
  if (state.state === 'clicked') console.error(`  ↳ @${username}: clicked "${state.label}"`);
  else console.error(`  ↳ @${username}: already "${state.label}" — skipping the click, verifying only`);
  await page.waitForTimeout(2000);

  const v = await verifyFollowed(page, pk);
  if (v.ok) return;

  const detail = `flags=${JSON.stringify(v.last.flags)}, button=${JSON.stringify(v.last.row)}`;
  const err = new Error(
    v.reason === 'not-followed'
      ? `@${username}: confirmed NOT followed — still unfollowed after ${VERIFY_ATTEMPTS} reloads (${detail})`
      : `@${username}: could not observe the state after ${VERIFY_ATTEMPTS} reloads (${detail}). ` +
        'Whether it went through is unknown — check the following list by hand rather than assuming it failed',
  );
  err.unconfirmed = true;
  throw err;
}

const describe = (c) => `${c.handle} (${c.targetId})${c.seed ? ` [seed @${c.seed}]` : ''}`;

async function main() {
  const rawArgs = process.argv;

  // `--verify <pk> <username>` — run the verification path without following anything. This is
  // how a human answers the "unreadable" case, and a regression test for the logic itself.
  const vIdx = rawArgs.indexOf('--verify');
  if (vIdx >= 0) {
    const [pk, username] = rawArgs.slice(vIdx + 1, vIdx + 3);
    if (!pk || !username) throw new Error('usage: --verify <pk> <username>');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { noDefaults: true });
    try {
      const ctx = browser.contexts()[0];
      const page = ctx.pages().find((p) => p.url().includes('threads.com')) || ctx.pages()[0] || (await ctx.newPage());
      await page.bringToFront().catch(() => {});
      await page.goto(`https://www.threads.com/@${username}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(2000);
      console.log(JSON.stringify({ username, pk, ...(await verifyFollowed(page, pk)) }, null, 2));
    } finally {
      await browser.close();
    }
    return;
  }

  const { mode, dryRun, max, delayMin, delayMax, seeds, seedSide, minFollowers, maxFollowers } =
    parseFollowArgs(rawArgs, { max: 3, delayMin: 90, delayMax: 300, explore: true });

  // Threads exposes one side only: a profile carries a follower count button and no following
  // list at all. Asked for the side that does not exist, this refuses rather than quietly
  // reading the other one — silently answering a different question is worse than stopping.
  if (mode === 'explore' && seedSideFor(CHANNEL, seedSide) !== 'followers') {
    console.error('threads: --seed-side following is not available — a Threads profile exposes no following list. Use --seed-side followers.');
    process.exit(1);
  }

  if (!dryRun) {
    warnRealRun(
      CHANNEL,
      'Meta polices follow automation aggressively, and a follow on a private account sends a follow REQUEST.' +
      (mode === 'explore' ? ' Explore targets have no prior connection to you — this is cold outreach.' : ''),
    );
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { noDefaults: true });
  try {
    const ctx = browser.contexts()[0];
    const page = ctx.pages().find((p) => p.url().includes('threads.com')) || ctx.pages()[0] || (await ctx.newPage());
    await page.bringToFront().catch(() => {});

    const ledgerIds = followedIds(CHANNEL);
    const refused = blockedIds(CHANNEL);

    let via, candidates;
    if (mode === 'explore') {
      via = 'explore';
      const seedList = seedsFor(CHANNEL, seeds);
      const bySeed = new Map();
      for (const s of seedList) {
        let users;
        try {
          await page.goto(`https://www.threads.com/@${encodeURIComponent(s.id)}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
          await page.waitForTimeout(2500);
          ({ users } = await collectAllFollowers(page)); // same collector as follow-back — it reads whatever profile is open
        } catch (e) {
          console.error(`  ↳ [skip] seed @${s.id}: ${e.message}`);
          continue;
        }
        const eligible = users.filter((u) => !u.following && !u.outgoingRequest && !ledgerIds.has(u.pk) && !refused.has(u.pk));
        // No count means the record did not carry one. On cold outreach an unknown account is
        // dropped rather than assumed acceptable — but if NONE of them carried one, that is the
        // payload shape having changed, not a seed full of countless accounts. Folding that into
        // "0 candidates" would report a healthy-looking run forever (same guard as listLikers').
        if (eligible.length && eligible.every((u) => u.followerCount == null)) {
          throw new Error(
            `seed @${s.id}: ${eligible.length} follower record(s) and not one follower_count — the modal payload shape has changed, ` +
            'so the quality floor cannot be applied. Treating it as a read failure rather than reporting no candidates.',
          );
        }
        const kept = eligible
          .filter((u) => u.followerCount != null && u.followerCount >= minFollowers && u.followerCount <= maxFollowers)
          .map((u) => ({ targetId: u.pk, handle: u.username, seed: s.id }));
        console.error(`  ↳ seed @${s.id}/followers: ${users.length} record(s) · ${kept.length} candidate(s)`);
        bySeed.set(s.id, kept);
      }
      if (!bySeed.size) throw new Error('every seed failed to load — nothing was explored (this is not "no candidates").');
      candidates = interleaveBySeed(bySeed);
    } else if (mode === 'follow-back') {
      via = 'follow-back';
      const handle = await resolveOwnHandle(page);
      console.error(`  ↳ own handle=@${handle}${PROFILE_HANDLE ? ' (THREADS_HANDLE)' : ' (derived from the session)'}`);
      await page.goto(`https://www.threads.com/@${handle}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(2500);
      const { users, total } = await collectAllFollowers(page);
      const followBack = users.filter((u) => u.followedBy && !u.following && !u.outgoingRequest);
      console.error(`  ↳ followers=${total ?? users.length} · records recovered=${users.length} · not followed back=${followBack.length}`);
      candidates = followBack
        .filter((u) => !ledgerIds.has(u.pk) && !refused.has(u.pk))
        .map((u) => ({ targetId: u.pk, handle: u.username }));
    } else {
      via = 'liker';
      const { users, aggregated } = await collectLikeActivity(page);
      console.error(
        `  ↳ ${users.length} like notification(s), ${aggregated} of them aggregated — **an aggregated ` +
        'notification names only one person**, so this is a subset of the likers, not a like count.',
      );
      // An unreadable relationship drops the candidate. Folding "could not read" into "not
      // following" would fire a write at someone already followed, which reads as probing.
      const kept = [];
      let unreadable = 0, already = 0;
      for (const u of users) {
        if (ledgerIds.has(u.pk) || refused.has(u.pk)) continue;
        const fs = await friendship(page, u.pk, IG_APP_ID);
        if (!fs) { unreadable++; continue; }
        if (fs.following || fs.outgoingRequest) { already++; continue; }
        kept.push(u);
      }
      console.error(`  ↳ ${already} already followed/requested excluded · ${unreadable} unreadable held back`);
      candidates = kept.map((u) => ({ targetId: u.pk, handle: u.username, srcPost: u.srcPost }));
    }
    if (refused.size) console.error(`  ↳ excluded ${refused.size} target(s) that cannot be followed from here`);

    await runFollows({
      channel: CHANNEL,
      candidates,
      via,
      dryRun,
      max,
      delayMin,
      delayMax,
      follow: (pk) => followUser(page, pk, candidates.find((c) => c.targetId === pk).handle),
      describe,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
