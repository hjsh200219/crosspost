#!/usr/bin/env node
// Remember Connect auto-follow — follow-back (people who follow you and you don't follow) and
// follow-likers (people who reacted to your recent posts). Auth reuses token.mjs exactly as
// remember-post.mjs does (env REMEMBER_TOKEN first, else capture the remember_session cookie
// over CDP and persist it), and the headers are the same too — the GET list endpoints want the
// origin/referer/desktop-UA combination as well.
//
// Dedup, cap, delay and dry-run live in ../lib/follow-core.mjs. The follow ledger is
// ledgers/follows-remember.json, separate from published-remember.jsonl.
//
// **Without --dry-run this really follows people from your account.**
//
// Endpoints (reverse-engineered, base https://connect-api.rememberapp.co.kr):
//   GET  /v1/follows/followers?per=100&page=N   → { data:[{id, open_profile_id, name, …}], meta:{…} }
//   GET  /v1/follows/followings?per=100&page=N  → same shape
//   POST /v1/follows {"following_user":{"open_profile_id": N}} → 201
//   GET  /v1/posts/:postId/reactions/profiles?page=1&per=100
//        → { data:{ open_profiles:[{id, name, headline, …}] }, meta:{…} }
//
// `open_profile_id` is the stable identifier for a person and the follow key — in the follows
// endpoints `id` is the relationship record id, which is NOT interchangeable. In the reactions
// response there is no separate field and `id` IS the open_profile_id (verified by opening
// /profile/<id>/posts for one reactor and matching the name/headline).
//
// usage: node follow.mjs (--follow-back|--follow-likers) [--dry-run] [--max N]
//        [--delay-min S] [--delay-max S] [--posts N]

import path from 'node:path';
import { getToken } from './token.mjs';
import { loadEnv, home, cdpPort } from '../lib/env.mjs';
import { followedIds, parseFollowArgs, runFollows } from '../lib/follow-core.mjs';

loadEnv();

const CHANNEL = 'remember';
const ENV_PATH = path.join(home(), '.env');
const PORT = cdpPort();
const BASE = 'https://connect-api.rememberapp.co.kr';
// Remember exposes no "who am I" endpoint, so the profile id is configuration (same variable
// remember-stats.mjs reads).
const PROFILE_ID = parseInt(process.env.REMEMBER_PROFILE_ID || '', 10);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// 429/401/403 will hit the remaining candidates the same way — mark them fatal so runFollows()
// stops the batch instead of grinding through it.
function classify(status, text, label) {
  const fatal = status === 401 || status === 403 || status === 429;
  const detail = (text || '').slice(0, 160);
  const err = new Error(fatal
    ? `${label} ${status} — rate limit or auth problem, batch stopped. ${detail}`
    : `${label} ${status}: ${detail}`);
  if (fatal) err.fatal = true;
  return err;
}

const headers = (auth) => ({
  accept: '*/*',
  authorization: auth,
  origin: 'https://connect.rememberapp.co.kr',
  referer: 'https://connect.rememberapp.co.kr/',
  'user-agent': UA,
});

async function apiGet(auth, pathname, params = {}) {
  const url = new URL(`${BASE}${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: headers(auth) });
  const text = await res.text();
  if (!res.ok) throw classify(res.status, text, pathname);
  try { return JSON.parse(text); } catch { throw new Error(`GET ${pathname} returned unparseable data: ${text.slice(0, 200)}`); }
}

async function apiPost(auth, pathname, jsonBody) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { ...headers(auth), 'content-type': 'application/json' },
    body: JSON.stringify(jsonBody),
  });
  const text = await res.text();
  if (res.status !== 201 && res.status !== 200) throw classify(res.status, text, pathname);
  return text;
}

// Pagination is `page` (1-based). A `cursor` parameter is silently ignored by the server, which
// then returns page 1 forever, so the last short page never arrives. `meta.total_pages` is the
// real signal; the short-page heuristic is the fallback and the 50-page ceiling is the backstop.
// `pick` exists because reactions/profiles nests one level deeper than the follows lists.
async function paginate(auth, pathname, pick = (body) => body?.data || []) {
  const out = [];
  let totalPages = Infinity;
  for (let page = 1; page <= totalPages && page <= 50; page++) {
    const body = await apiGet(auth, pathname, { per: 100, page });
    const items = pick(body);
    out.push(...items);
    if (body?.meta?.total_pages) totalPages = body.meta.total_pages;
    if (items.length < 100) break;
  }
  return out;
}

const listFollowers = (auth) => paginate(auth, '/v1/follows/followers');
const listFollowings = (auth) => paginate(auth, '/v1/follows/followings');
const reactorsOf = (auth, postId) =>
  paginate(auth, `/v1/posts/${postId}/reactions/profiles`, (body) => body?.data?.open_profiles || []);

// Your most recent N posts. list_by_author is a POST with querystring pagination (same endpoint
// remember-stats.mjs uses) and comes back newest-first, so page 1 is the latest.
async function myRecentPosts(auth, n) {
  const out = [];
  for (let page = 1; out.length < n && page <= 20; page++) {
    const text = await apiPost(auth, `/v1/posts/list_by_author?page=${page}&per=20`, {
      author_type: 'USER',
      open_profile_id: PROFILE_ID,
    });
    let body;
    try { body = JSON.parse(text); } catch { throw new Error(`list_by_author returned unparseable data: ${text.slice(0, 200)}`); }
    const items = body?.data || [];
    out.push(...items);
    if (items.length < 20) break;
  }
  return out.slice(0, n);
}

// Reactors of the most recent postCount posts (skipping the ones with no reactions), minus
// anyone already followed or recorded. A reactor on several posts keeps the first srcPost.
async function likerCandidates(auth, followingSet, ledgerIds, postCount) {
  const posts = (await myRecentPosts(auth, postCount)).filter((p) => (p.post_stats?.reaction_count || 0) > 0);
  const byId = new Map();
  for (const post of posts) {
    for (const r of await reactorsOf(auth, post.id)) {
      const id = String(r.id);
      if (followingSet.has(id) || ledgerIds.has(id) || byId.has(id)) continue;
      byId.set(id, { targetId: id, handle: r.name, srcPost: post.id });
    }
  }
  return [...byId.values()];
}

const describe = (c) => `${c.handle} (${c.targetId})${c.srcPost ? ` [via ${c.srcPost}]` : ''}`;

async function main() {
  if (!Number.isFinite(PROFILE_ID)) {
    throw new Error('REMEMBER_PROFILE_ID is not set — add it to $CROSSPOST_HOME/.env (see config/.env.example).');
  }
  const { mode, dryRun, max, delayMin, delayMax, posts } = parseFollowArgs(process.argv);

  const { hdr: auth } = await getToken({ envPath: ENV_PATH, port: PORT });
  const followingSet = new Set((await listFollowings(auth)).map((u) => String(u.open_profile_id)));
  const ledgerIds = followedIds(CHANNEL);

  let via, candidates;
  if (mode === 'follow-back') {
    via = 'follow-back';
    const followers = await listFollowers(auth);
    console.error(`  ↳ followers=${followers.length} following=${followingSet.size}`);
    candidates = followers
      .filter((u) => !followingSet.has(String(u.open_profile_id)) && !ledgerIds.has(String(u.open_profile_id)))
      .map((u) => ({ targetId: String(u.open_profile_id), handle: u.name }));
  } else {
    via = 'liker';
    candidates = await likerCandidates(auth, followingSet, ledgerIds, posts);
  }

  await runFollows({
    channel: CHANNEL,
    candidates,
    via,
    dryRun,
    max,
    delayMin,
    delayMax,
    // A nested body is required — a flat one is rejected with 400.
    follow: (opid) => apiPost(auth, '/v1/follows', { following_user: { open_profile_id: Number(opid) } }),
    describe,
  });
}

main().catch((e) => { console.error(e.message); process.exit(1); });
