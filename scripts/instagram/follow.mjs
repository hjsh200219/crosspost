#!/usr/bin/env node
// Instagram auto-follow — follow-back (accounts that follow you and you don't follow) and
// follow-likers (accounts that liked your recent posts).
//
// **The numeric id here is NOT `IG_USER_ID`.** That one is the Graph API's page-scoped id used
// for publishing; the read endpoints below are the legacy web-private API and use a different
// "pk" namespace. It is resolved fresh each run from `web_profile_info` — never hardcode it and
// never reuse the Graph id, or every call comes back 404/empty.
//
// ⚠️ Meta polices follow automation hard. Defaults here are therefore much more conservative
// than follow-core's — `--max 3` and a 90–300s delay — and a non-dry run prints a warning.
// A measured incident worth knowing: a follow click on a private account sends a follow REQUEST,
// which is a real action even though the button only says "requested".
//
// Reading (browserless, no browser needed beyond the cookie):
//   GET /api/v1/users/web_profile_info/?username=<your username>  → data.user.id + counts
//   GET /api/v1/friendships/<id>/followers/?count=12[&max_id=…]
//   GET /api/v1/friendships/<id>/following/?count=12[&max_id=…]
// **Required headers** (without them: 400 "SecFetch Policy violation" or an empty body):
// `x-ig-app-id`, `x-requested-with: XMLHttpRequest`, a referer on your own profile, and the
// sec-fetch-* trio. Send the CDP profile's **whole** cookie jar — a subset gets 401.
//
// The followers modal offers no follow-back state in the UI, so candidates come from the set
// difference followers − following, and each candidate is then re-checked individually
// (`friendships/show`) because that pagination loses recovery: measured, ~45 pages of a 536-strong
// following list returned 536 rows but only 374 unique pks, so the raw count matches the profile
// number by coincidence while the set is incomplete. **Dedup by pk and compare the UNIQUE count**
// against the profile number — comparing raw lengths hides the loss.
//
// Follow WRITE — the real button is clicked in-page. The mutation body carries per-page-load
// signed tokens (`__csr`, `__dyn`, `__hs`), so it cannot be reassembled by hand. Confirmation is
// a `friendships/show` re-read: `following:true`, or `outgoing_request:true` for a private
// account (that IS the correct end state there).
//
// follow-likers is the cleanest liker path of any channel here:
//   GET /api/v1/feed/user/<id>/?count=24[&max_id=…]  → your posts with per-post like_count
//   GET /api/v1/media/<pk>/likers/                   → users[] WITH friendship_status inline
// **`x-csrftoken` is mandatory for likers** (403 "CSRF token missing or incorrect" without it),
// even though followers/following answer 200 without it. Note the ledger's Graph ids cannot be
// used here — same namespace trap as above. Threads' identical-looking endpoint returns a count
// with an empty users array; do not assume one channel's result transfers to the other.
//
// explore (cold discovery) reads a seed account's `friendships/<pk>/{following,followers}` — the
// same endpoints answer for an arbitrary public account. Those rows carry no metrics, so the
// quality floor needs a second call per candidate (`web_profile_info`), which is capped.
//
// usage: node follow.mjs (--follow-back|--follow-likers|--follow-explore) [--dry-run] [--max N]
//        [--delay-min S] [--delay-max S] [--posts N]
//        explore only: [--seed <username> …] [--seed-side following|followers]
//                      [--min-followers N] [--max-followers N]
// Requires a logged-in instagram.com session in the shared CDP browser.

import { chromium } from 'playwright';
import { loadEnv, cdpPort } from '../lib/env.mjs';
import { blockedIds, followedIds, parseFollowArgs, runFollows, warnRealRun } from '../lib/follow-core.mjs';
import { seedsFor, seedSideFor, interleaveBySeed } from '../lib/follow-seeds.mjs';

loadEnv();

const CHANNEL = 'instagram';
const PORT = cdpPort();
const USERNAME = process.env.IG_USERNAME;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const APP_ID = process.env.IG_APP_ID || '936619743392459'; // the public web app id
const PAGE_SIZE = 12;
const MAX_PAGES = 60; // backstop (60 × 12 = 720 accounts)
// DOM matcher, not user-facing copy — the label Instagram renders in the session's interface
// language. Translating it breaks the click; override it instead.
const LABEL_FOLLOW = process.env.IG_FOLLOW_LABEL || '팔로우';

function classify(status, text, label) {
  const fatal = status === 401 || status === 403 || status === 429;
  // A 401 means either "rate limited" or "logged out", and **the message text is identical for
  // both** — the discriminator is `require_login` in the body. Getting this backwards is costly:
  // treating a logged-out session as a throttle means waiting hours for something that will
  // never clear on its own. What hides it is that some endpoints answer 200 while logged out
  // (`web_profile_info`, `feed/user` read public profiles), so only the authenticated
  // `friendships/*` calls fail and it looks like a per-endpoint block.
  const body = text || '';
  const needLogin = status === 401 && /"require_login"\s*:\s*true/.test(body);
  const throttled = status === 401 && !needLogin && /please wait a few minutes/i.test(body);
  const msg = needLogin
    ? `${label} HTTP 401 (session expired — require_login). Waiting will not fix it: log into instagram.com once, by hand, in the CDP browser. ` +
      'Note the body text is the same as a rate limit, so never judge by the wording.'
    : throttled
      ? `${label} HTTP 401 (rate limited). **Do not retry and do not re-login** — wait at least several minutes. ` +
        'The usual cause is too many requests at once (for example running both modes of this channel in parallel).'
      : `${label} HTTP ${status}: ${body.slice(0, 160)}`;
  const err = new Error(msg);
  if (fatal) err.fatal = true;
  if (throttled) err.throttled = true;
  if (needLogin) err.needLogin = true;
  return err;
}

// --- minimum gap between requests ---
// Reading alone can trigger a rate limit and an automation warning on the account: paginating a
// few hundred follows twelve at a time with no delay looks nothing like a person using the app.
// Every request through igFetch is serialized behind a minimum gap with jitter. That guard is
// per-process, so **the two modes of this channel still have to be run sequentially**.
const IG_MIN_GAP_MS = Number(process.env.IG_MIN_GAP_MS || 900);
const IG_JITTER_MS = Number(process.env.IG_JITTER_MS || 500);
let igGate = Promise.resolve();
let igLastAt = 0;

function igThrottle() {
  const wait = () => new Promise((resolve) => {
    const gap = IG_MIN_GAP_MS + Math.random() * IG_JITTER_MS;
    const due = igLastAt + gap - Date.now();
    setTimeout(() => { igLastAt = Date.now(); resolve(); }, Math.max(0, due));
  });
  igGate = igGate.then(wait, wait); // the gap holds even after a failed request
  return igGate;
}

async function igFetch(cookie, path) {
  await igThrottle();
  const csrf = (cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
  const res = await fetch(`https://www.instagram.com${path}`, {
    headers: {
      cookie, 'user-agent': UA, 'x-ig-app-id': APP_ID, 'x-requested-with': 'XMLHttpRequest',
      'x-csrftoken': csrf,
      referer: `https://www.instagram.com/${USERNAME}/`,
      'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
    },
  });
  const text = await res.text();
  if (res.status !== 200) throw classify(res.status, text, path);
  try { return JSON.parse(text); } catch {
    // A 200 carrying the app shell instead of JSON is an endpoint block on the account, not a
    // parse problem and not a session problem — the session can be perfectly alive, and the same
    // URL fetched from inside a logged-in instagram.com document answers the same way. Swapping
    // HTTP clients does not help. Left as "unparseable data" it reads like a transient glitch and
    // invites a retry loop, so it is called out and made fatal.
    if (/^\s*<(!doctype|html)/i.test(text)) {
      const err = new Error(
        `${path} answered HTTP 200 with HTML instead of JSON — Instagram is blocking this endpoint for the account. ` +
        'Retrying, re-logging in and changing HTTP client all make no difference; leave it for a day.',
      );
      err.fatal = true;
      err.endpointBlocked = true;
      throw err;
    }
    throw new Error(`${path} returned unparseable data: ${text.slice(0, 160)}`);
  }
}

async function resolveMyId(cookie) {
  const data = await igFetch(cookie, `/api/v1/users/web_profile_info/?username=${USERNAME}`);
  const u = data?.data?.user;
  if (!u?.id) throw new Error('could not read your numeric id from web_profile_info');
  return { id: u.id, followerCount: u.edge_followed_by?.count, followingCount: u.edge_follow?.count };
}

// kind = 'followers' | 'following'. Returns {pk, username, fullName}[], deduped by pk.
async function listPeople(cookie, myId, kind) {
  const byPk = new Map();
  let maxId = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const qs = `?count=${PAGE_SIZE}` + (maxId ? `&max_id=${encodeURIComponent(maxId)}` : '');
    const data = await igFetch(cookie, `/api/v1/friendships/${myId}/${kind}/${qs}`);
    const users = data.users || [];
    for (const u of users) {
      const pk = String(u.pk);
      if (!byPk.has(pk)) byPk.set(pk, { pk, username: u.username, fullName: u.full_name || u.username });
    }
    if (!data.has_more || !users.length) break;
    maxId = data.next_max_id;
  }
  return [...byPk.values()];
}

// Your most recent posts, including the ones with zero likes, so the caller can tell "read the
// posts, nobody liked them" from "could not read the posts".
async function recentMedia(cookie, myId, postCount) {
  const out = [];
  let maxId = null;
  for (let i = 0; i < MAX_PAGES && out.length < postCount; i++) {
    const qs = '?count=24' + (maxId ? `&max_id=${encodeURIComponent(maxId)}` : '');
    const data = await igFetch(cookie, `/api/v1/feed/user/${myId}/${qs}`);
    const items = data.items || [];
    for (const m of items) out.push({ pk: String(m.pk), code: m.code, likeCount: m.like_count || 0 });
    if (!data.more_available || !items.length) break;
    maxId = data.next_max_id;
  }
  return out.slice(0, postCount);
}

// Likers of one post. **A positive user_count with an empty users array throws** — folding it
// into "zero likes" would report no candidates forever while looking healthy.
async function listLikers(cookie, media) {
  const byPk = new Map();
  let maxId = null;
  let userCount = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const qs = maxId ? `?max_id=${encodeURIComponent(maxId)}` : '';
    const data = await igFetch(cookie, `/api/v1/media/${media.pk}/likers/${qs}`);
    if (data.user_count != null) userCount = data.user_count;
    const users = data.users || [];
    for (const u of users) {
      const pk = String(u.pk);
      if (byPk.has(pk)) continue;
      const fs = u.friendship_status || {};
      byPk.set(pk, {
        pk, username: u.username,
        following: !!fs.following, followedBy: !!fs.followed_by, outgoingRequest: !!fs.outgoing_request,
      });
    }
    if (!users.length || !data.next_max_id) break;
    maxId = data.next_max_id;
  }
  if ((userCount ?? 0) > 0 && byPk.size === 0) {
    throw new Error(`likers ${media.code}: user_count=${userCount} but no users parsed — treating as a read failure`);
  }
  return [...byPk.values()];
}

// --- explore: mine a seed account's neighbourhood ---
// Two stages, because the list rows carry no metrics. A `friendships/<pk>/{following,followers}`
// entry has pk, username, is_private, has_anonymous_profile_picture and little else — no follower
// count and no friendship_status. So: filter on what the listing does say, then spend one
// `web_profile_info` per survivor, capped. That single call answers everything left — follower
// count, post count, and whether you already follow them — so the per-candidate
// `friendships/show` used elsewhere is not needed here.
const EXPLORE_SEED_PAGES = 5;   // 5 × 12 = 60 accounts per seed
const ENRICH_CAP = 40;          // upper bound on profile lookups per run — every one is another
                                // automated read on an account Meta already watches

async function listPeopleOf(cookie, pk, kind, pages) {
  const byPk = new Map();
  let maxId = null;
  for (let i = 0; i < pages; i++) {
    const qs = `?count=${PAGE_SIZE}` + (maxId ? `&max_id=${encodeURIComponent(maxId)}` : '');
    const data = await igFetch(cookie, `/api/v1/friendships/${pk}/${kind}/${qs}`);
    const users = data.users || [];
    for (const u of users) {
      const id = String(u.pk);
      if (!byPk.has(id)) {
        byPk.set(id, {
          pk: id,
          username: u.username,
          isPrivate: !!u.is_private,
          defaultAvatar: !!u.has_anonymous_profile_picture,
        });
      }
    }
    if (!data.has_more || !users.length) break;
    maxId = data.next_max_id;
  }
  return [...byPk.values()];
}

async function profileOf(cookie, username) {
  const data = await igFetch(cookie, `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);
  const u = data?.data?.user;
  if (!u) return null;
  return {
    id: u.id,
    followers: u.edge_followed_by?.count ?? null,
    posts: u.edge_owner_to_timeline_media?.count ?? 0,
    following: !!u.followed_by_viewer,
    requested: !!u.requested_by_viewer,
  };
}

async function followUser(page, cookie, pk, username) {
  await page.goto(`https://www.instagram.com/${username}/`, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(2000);
  const clicked = await page.evaluate((label) => {
    const el = [...document.querySelectorAll('button, div[role=button]')].find((b) => (b.textContent || '').trim() === label);
    if (el) { el.click(); return true; }
    return false;
  }, LABEL_FOLLOW);
  if (!clicked) {
    // "No button" conflates two causes: already following/requested (so there is no follow
    // button), or a render/layout problem. Split them with the same friendships/show call the
    // confirmation uses — if the desired end state already holds, that is a success, not a failure.
    const cur = await igFetch(cookie, `/api/v1/friendships/show/${pk}/`).catch((e) => ({ error: e.message }));
    if (cur.following === true || cur.outgoing_request === true) {
      console.error(`  ↳ @${username}: already following/requested — the missing button is a consequence of that`);
      return;
    }
    throw new Error(`@${username}: no follow button and no existing relationship — probably a render delay or layout change (${JSON.stringify(cur).slice(0, 120)})`);
  }
  await page.waitForTimeout(2000);

  const status = await igFetch(cookie, `/api/v1/friendships/show/${pk}/`).catch((e) => ({ error: e.message }));
  if (!(status.following === true || status.outgoing_request === true)) {
    const err = new Error(`@${username}: the re-read shows neither following nor outgoing_request (${JSON.stringify(status).slice(0, 120)})`);
    err.unconfirmed = true;
    throw err;
  }
}

const describe = (c) => `${c.handle} (${c.targetId})${c.seed ? ` [seed @${c.seed}]` : ''}`;

async function main() {
  const parsed = parseFollowArgs(process.argv, { max: 3, delayMin: 90, delayMax: 300, explore: true });
  const { mode, dryRun, max, delayMin, delayMax, posts, seeds, seedSide, minFollowers, maxFollowers } = parsed;

  if (!USERNAME) {
    console.error('IG_USERNAME is not set in $CROSSPOST_HOME/.env — it is the account whose followers/likers are read (not IG_USER_ID).');
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
    const cookies = await ctx.cookies('https://www.instagram.com');
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    if (!cookie) throw new Error('no instagram.com cookies in the CDP browser — log in there first');

    const { id: myId, followerCount, followingCount } = await resolveMyId(cookie);
    const ledgerIds = followedIds(CHANNEL);
    const blocked = blockedIds(CHANNEL);
    const pageForWrites = async () => {
      const p = ctx.pages().find((x) => x.url().includes('instagram.com')) || ctx.pages()[0] || (await ctx.newPage());
      await p.bringToFront().catch(() => {});
      return p;
    };

    if (mode === 'explore') {
      const side = seedSideFor(CHANNEL, seedSide);
      const kind = side === 'following' ? 'following' : 'followers';
      const seedList = seedsFor(CHANNEL, seeds);
      const bySeed = new Map();
      let enrichBudget = ENRICH_CAP;
      let readFailures = 0;
      for (const s of seedList) {
        let rows;
        try {
          const seedProfile = await profileOf(cookie, s.id);
          if (!seedProfile?.id) throw new Error('no such account');
          rows = await listPeopleOf(cookie, seedProfile.id, kind, EXPLORE_SEED_PAGES);
        } catch (e) {
          readFailures++;
          console.error(`  ↳ [skip] seed @${s.id}: ${e.message}`);
          if (e.fatal) throw e; // an endpoint block or a dead session hits every seed the same way
          continue;
        }
        const shortlist = rows.filter((u) => u.pk !== String(myId) && !u.isPrivate && !u.defaultAvatar
          && !ledgerIds.has(u.pk) && !blocked.has(u.pk));
        const kept = [];
        for (const u of shortlist) {
          if (enrichBudget <= 0) break;
          enrichBudget--;
          const p = await profileOf(cookie, u.username).catch((e) => {
            // Some accounts answer 400 on this endpoint for reasons on Instagram's side. Skipping
            // that candidate is right; treating it as a channel failure is not.
            console.error(`  ↳ [skip] @${u.username}: ${e.message.slice(0, 100)}`);
            return null;
          });
          if (!p) continue;
          if (p.following || p.requested) continue;
          if (p.posts < 1) continue;
          if (p.followers == null || p.followers < minFollowers || p.followers > maxFollowers) continue;
          kept.push({ targetId: u.pk, handle: u.username, seed: s.id });
        }
        console.error(`  ↳ seed @${s.id}/${kind}: ${rows.length} read · ${shortlist.length} shortlisted · ${kept.length} candidate(s)`);
        bySeed.set(s.id, kept);
      }
      if (!bySeed.size) throw new Error(`every seed failed to load (${readFailures}) — nothing was explored (this is not "no candidates").`);
      if (enrichBudget <= 0) console.error(`  !! profile-lookup budget (${ENRICH_CAP}) exhausted — some shortlisted accounts were never evaluated.`);
      const candidates = interleaveBySeed(bySeed);

      if (dryRun) {
        await runFollows({ channel: CHANNEL, candidates, via: 'explore', dryRun, max, delayMin, delayMax, follow: async () => {}, describe });
        return;
      }
      const ep = await pageForWrites();
      await runFollows({
        channel: CHANNEL, candidates, via: 'explore', dryRun, max, delayMin, delayMax,
        follow: (pk) => followUser(ep, cookie, pk, candidates.find((c) => c.targetId === pk).handle),
        describe,
      });
      return;
    }

    if (mode === 'follow-likers') {
      const media = await recentMedia(cookie, myId, posts);
      const withLikes = media.filter((m) => m.likeCount > 0);
      console.error(`  ↳ read ${media.length} post(s) · ${withLikes.length} with likes (${withLikes.reduce((s, m) => s + m.likeCount, 0)} likes total)`);
      const byPk = new Map();
      for (const m of withLikes) {
        let likers;
        try { likers = await listLikers(cookie, m); } catch (e) {
          console.error(`  ↳ [skip] ${m.code}: ${e.message}`);
          if (e.fatal) throw e;
          continue;
        }
        for (const u of likers) if (!byPk.has(u.pk)) byPk.set(u.pk, { ...u, srcPost: m.code });
      }
      const all = [...byPk.values()];
      const already = all.filter((u) => u.following || u.outgoingRequest).length;
      const candidates = all
        .filter((u) => u.pk !== String(myId) && !u.following && !u.outgoingRequest && !ledgerIds.has(u.pk))
        .map((u) => ({ targetId: u.pk, handle: u.username, srcPost: u.srcPost }));
      console.error(`  ↳ ${all.length} unique liker(s) · ${already} already followed/requested excluded`);

      if (dryRun) {
        await runFollows({ channel: CHANNEL, candidates, via: 'liker', dryRun, max, delayMin, delayMax, follow: async () => {}, describe });
        return;
      }
      const lp = await pageForWrites();
      await runFollows({
        channel: CHANNEL, candidates, via: 'liker', dryRun, max, delayMin, delayMax,
        follow: (pk) => followUser(lp, cookie, pk, candidates.find((c) => c.targetId === pk).handle),
        describe,
      });
      return;
    }

    const [followers, following] = await Promise.all([
      listPeople(cookie, myId, 'followers'),
      listPeople(cookie, myId, 'following'),
    ]);
    console.error(`  ↳ followers=${followers.length} (profile says ${followerCount}) following=${following.length} (profile says ${followingCount})`);
    if (followers.length !== followerCount || following.length !== followingCount) {
      console.error('  ↳ warning: recovered counts differ from the profile numbers — the lists may have changed mid-pagination or come back partial (nothing is truncated; what was recovered is used).');
    }

    const followingSet = new Set(following.map((u) => u.pk));
    const rawCandidates = followers
      .filter((u) => !followingSet.has(u.pk) && !ledgerIds.has(u.pk))
      .map((u) => ({ targetId: u.pk, handle: u.username }));

    // The set difference is only as good as the following list, and that list under-recovers.
    // Re-check every candidate individually before writing anything — the same endpoint the
    // confirmation step uses.
    console.error(`  ↳ re-checking ${rawCandidates.length} candidate(s) with friendships/show…`);
    const candidates = [];
    for (const c of rawCandidates) {
      const status = await igFetch(cookie, `/api/v1/friendships/show/${c.targetId}/`).catch((e) => ({ error: e.message }));
      if (status.following === true || status.outgoing_request === true) {
        console.error(`  ↳ skipped: ${c.handle} (${c.targetId}) — already following/requested (stale candidate from an incomplete following list)`);
        continue;
      }
      candidates.push(c);
      await new Promise((r) => setTimeout(r, 400));
    }
    console.error(`  ↳ candidates after the re-check=${candidates.length} (raw=${rawCandidates.length})`);

    if (dryRun) {
      await runFollows({ channel: CHANNEL, candidates, via: 'follow-back', dryRun, max, delayMin, delayMax, follow: async () => {}, describe });
      return;
    }

    const page = await pageForWrites();
    await runFollows({
      channel: CHANNEL,
      candidates,
      via: 'follow-back',
      dryRun,
      max,
      delayMin,
      delayMax,
      follow: (pk) => followUser(page, cookie, pk, candidates.find((c) => c.targetId === pk).handle),
      describe,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
