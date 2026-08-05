#!/usr/bin/env node
// X auto-follow — follow-back (accounts that follow you and you don't follow) and
// follow-likers (accounts that liked your recent posts). OAuth 1.0a (HMAC-SHA1) signing uses
// the same $CROSSPOST_HOME/.env keys as post-api.mjs, except a GET has to fold its query
// parameters into the signature base, so authHeader(method, url) reads them off the URL.
//
// Dedup, cap, delay and dry-run live in ../lib/follow-core.mjs. The follow ledger is
// ledgers/follows-x.json, separate from published-x.json.
//
// **Without --dry-run this really follows people from your account.**
// usage: node follow.mjs (--follow-back|--follow-likers) [--dry-run] [--max N]
//        [--delay-min S] [--delay-max S] [--posts N]

import { readFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { loadEnv, dataPath } from '../lib/env.mjs';
import { followedIds, parseFollowArgs, runFollows } from '../lib/follow-core.mjs';

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

const describe = (c) => `@${c.handle} (${c.targetId})${c.srcPost ? ` [via ${c.srcPost}]` : ''}`;

async function main() {
  if (!CK || !CS || !AT || !AS) {
    throw new Error('X credentials missing — set X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET in $CROSSPOST_HOME/.env');
  }
  const { mode, dryRun, max, delayMin, delayMax, posts } = parseFollowArgs(process.argv);

  const myId = await getMe();
  const following = await listFollowing(myId);
  const ledgerIds = followedIds(CHANNEL);
  const isCandidate = (id) => !following.has(id) && !ledgerIds.has(id);

  let via, candidates;
  if (mode === 'follow-back') {
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
