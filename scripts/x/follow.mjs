#!/usr/bin/env node
// X auto-follow — follow-back (accounts that follow you and you don't follow) and
// follow-likers (accounts that liked your recent posts). OAuth 1.0a (HMAC-SHA1) signing uses
// the same $CROSSPOST_HOME/.env keys as post-api.mjs, except a GET has to fold its query
// parameters into the signature base, so authHeader(method, url) reads them off the URL.
//
// Dedup, cap, delay and dry-run live in ../lib/follow-core.mjs. The follow ledger is
// ledgers/follows-x.json, separate from published-x.json.
//
// explore (cold discovery) also works here: `GET /2/users/:id/{followers,following}` answers for
// an arbitrary account and returns `public_metrics` inline, so the quality floor costs no extra
// request. Reads are billed on the pay-per-use plan, so one page (100 accounts) per seed.
//
// **Without --dry-run this really follows people from your account.**
// usage: node follow.mjs (--follow-back|--follow-likers|--follow-explore) [--dry-run] [--max N]
//        [--delay-min S] [--delay-max S] [--posts N]
//        explore only: [--seed <handle> …] [--seed-side following|followers]
//                      [--min-followers N] [--max-followers N]

import { readFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { loadEnv, dataPath } from '../lib/env.mjs';
import { blockedIds, followedIds, parseFollowArgs, runFollows, warnRealRun } from '../lib/follow-core.mjs';
import { seedsFor, seedSideFor, interleaveBySeed } from '../lib/follow-seeds.mjs';

loadEnv();

const CHANNEL = 'x';
const PUBLISHED = dataPath('ledgers/published-x.json'); // source of posts to read likers from
const API = 'https://api.x.com/2';

const CK = process.env.X_API_KEY;
const CS = process.env.X_API_SECRET;
const AT = process.env.X_ACCESS_TOKEN;
const AS = process.env.X_ACCESS_SECRET;

// --- OAuth 1.0a (RFC3986 percent-encoding, HMAC-SHA1) ---
// Shared by GET and POST: if the URL carries searchParams (GET) they join the signature base;
// a JSON body (POST) is not signed, so only the oauth_* parameters are.
const enc = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function authHeader(method, url) {
  const u = new URL(url);
  const oauth = {
    oauth_consumer_key: CK,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: AT,
    oauth_version: '1.0',
  };
  const allParams = { ...oauth };
  for (const [k, v] of u.searchParams) allParams[k] = v;
  const paramStr = Object.keys(allParams).sort().map((k) => `${enc(k)}=${enc(allParams[k])}`).join('&');
  const base = [method.toUpperCase(), enc(`${u.origin}${u.pathname}`), enc(paramStr)].join('&');
  const signingKey = `${enc(CS)}&${enc(AS)}`;
  oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(base).digest('base64');
  return 'OAuth ' + Object.keys(oauth).sort().map((k) => `${enc(k)}="${enc(oauth[k])}"`).join(', ');
}

// 429/402/401/403 will very likely hit the remaining candidates the same way, so they are
// marked fatal and runFollows() stops the batch — same stance as post-api.mjs.
function classify(status, json, label) {
  const detail = json?.detail || json?.title || json?.errors?.[0]?.message || label;
  const fatal = status === 429 || status === 402 || status === 401 || status === 403;
  let msg;
  if (status === 429) msg = `rate limited (429) — wait and retry. ${detail}`;
  else if (status === 402) msg = `credit exhausted (402) — check the X API plan/balance. ${detail}`;
  else if (status === 401 || status === 403) msg = `auth/permission failure (${status}) — check the .env tokens or account status. ${detail}`;
  else msg = `X API ${status}: ${detail}`;
  const err = new Error(msg);
  if (fatal) err.fatal = true;
  return err;
}

async function apiGet(pathname, params = {}) {
  const url = new URL(`${API}${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: authHeader('GET', url.toString()) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw classify(res.status, body, pathname);
  return body;
}

async function apiPost(pathname, jsonBody) {
  const url = `${API}${pathname}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: authHeader('POST', url), 'Content-Type': 'application/json' },
    body: JSON.stringify(jsonBody),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw classify(res.status, body, pathname);
  return body;
}

async function getMe() {
  return (await apiGet('/users/me'))?.data?.id;
}

// ids already followed. 1000 per page, up to 5 pages.
async function listFollowing(myId) {
  const ids = new Set();
  let token;
  for (let page = 0; page < 5; page++) {
    const params = { max_results: 1000 };
    if (token) params.pagination_token = token;
    const body = await apiGet(`/users/${myId}/following`, params);
    for (const u of body.data || []) ids.add(u.id);
    token = body.meta?.next_token;
    if (!token) break;
  }
  return ids;
}

async function listFollowers(myId) {
  const out = [];
  let token;
  for (let page = 0; page < 5; page++) {
    const params = { max_results: 1000, 'user.fields': 'username' };
    if (token) params.pagination_token = token;
    const body = await apiGet(`/users/${myId}/followers`, params);
    for (const u of body.data || []) out.push({ id: u.id, username: u.username });
    token = body.meta?.next_token;
    if (!token) break;
  }
  return out;
}

function loadPublished() {
  if (!existsSync(PUBLISHED)) return [];
  try { return JSON.parse(readFileSync(PUBLISHED, 'utf8')); } catch { return []; }
}

// Likers of the most recent --posts root tweets, deduped by user id.
async function likerCandidates(postCount) {
  const rootIds = loadPublished()
    .filter((e) => e.rootId && !e.dup)
    .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
    .slice(0, postCount)
    .map((e) => e.rootId);
  const byId = new Map();
  for (const tweetId of rootIds) {
    const body = await apiGet(`/tweets/${tweetId}/liking_users`, { max_results: 100, 'user.fields': 'username' });
    for (const u of body.data || []) {
      if (!byId.has(u.id)) byId.set(u.id, { id: u.id, username: u.username, srcPost: tweetId });
    }
  }
  return [...byId.values()];
}

// --- explore: one page of a seed's adjacency graph ---
// `user.fields=public_metrics` means the quality floor is applied from the listing itself, with
// no per-candidate lookup — every extra call here is billed and is another automated read.
async function seedNeighbours(handle, side) {
  const seed = await apiGet('/users/by/username/' + encodeURIComponent(handle));
  const id = seed?.data?.id;
  if (!id) throw new Error(`seed @${handle}: no such account`);
  const body = await apiGet(`/users/${id}/${side}`, {
    max_results: 100,
    'user.fields': 'username,public_metrics,protected',
  });
  return (body.data || []).map((u) => ({
    id: u.id,
    username: u.username,
    followers: u.public_metrics?.followers_count ?? null,
    protected: !!u.protected,
  }));
}

const describe = (c) => `@${c.handle} (${c.targetId})${c.seed ? ` [seed @${c.seed}]` : ''}${c.srcPost ? ` [via ${c.srcPost}]` : ''}`;

async function main() {
  if (!CK || !CS || !AT || !AS) {
    throw new Error('X credentials missing — set X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET in $CROSSPOST_HOME/.env');
  }
  const { mode, dryRun, max, delayMin, delayMax, posts, seeds, seedSide, minFollowers, maxFollowers } =
    parseFollowArgs(process.argv, { explore: true });

  if (mode === 'explore' && !dryRun) {
    warnRealRun(CHANNEL, 'explore follows accounts with no prior connection to you — cold outreach, not a follow-back.');
  }

  const myId = await getMe();
  const following = await listFollowing(myId);
  const ledgerIds = followedIds(CHANNEL);
  const blocked = blockedIds(CHANNEL);
  const isCandidate = (id) => !following.has(id) && !ledgerIds.has(id) && !blocked.has(id) && id !== myId;

  let via, candidates;
  if (mode === 'explore') {
    via = 'explore';
    const side = seedSideFor(CHANNEL, seedSide);
    const list = seedsFor(CHANNEL, seeds);
    const bySeed = new Map();
    for (const s of list) {
      let people;
      try { people = await seedNeighbours(s.id, side); } catch (e) {
        console.error(`  ↳ [skip] seed @${s.id}: ${e.message}`);
        if (e.fatal) throw e;
        continue;
      }
      const kept = people
        .filter((u) => isCandidate(u.id) && !u.protected)
        // A follower count is the only quality signal available without a second request. Both
        // ends matter: below the floor is usually an empty or bot account, above the ceiling is
        // a celebrity who will never notice. `null` is unknown, and on cold outreach unknown is
        // excluded rather than assumed fine.
        .filter((u) => u.followers != null && u.followers >= minFollowers && u.followers <= maxFollowers)
        .map((u) => ({ targetId: u.id, handle: u.username, seed: s.id }));
      console.error(`  ↳ seed @${s.id}/${side}: ${people.length} read · ${kept.length} candidate(s)`);
      bySeed.set(s.id, kept);
    }
    if (!bySeed.size) throw new Error('every seed failed to load — nothing was explored (this is not "no candidates").');
    candidates = interleaveBySeed(bySeed);
  } else if (mode === 'follow-back') {
    via = 'follow-back';
    const followers = await listFollowers(myId);
    console.error(`  ↳ followers=${followers.length} following=${following.size}`);
    candidates = followers.filter((u) => isCandidate(u.id)).map((u) => ({ targetId: u.id, handle: u.username }));
  } else {
    via = 'liker';
    const likers = await likerCandidates(posts);
    candidates = likers.filter((u) => isCandidate(u.id))
      .map((u) => ({ targetId: u.id, handle: u.username, srcPost: u.srcPost }));
  }

  await runFollows({
    channel: CHANNEL,
    candidates,
    via,
    dryRun,
    max,
    delayMin,
    delayMax,
    follow: (targetId) => apiPost(`/users/${myId}/following`, { target_user_id: targetId }),
    describe,
  });
}

main().catch((e) => { console.error(e.message); process.exit(1); });
