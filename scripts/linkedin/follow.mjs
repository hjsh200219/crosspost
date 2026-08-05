#!/usr/bin/env node
// LinkedIn auto-follow — follow-back (people who follow you and you don't follow) and
// follow-likers (people who reacted to your recent posts).
//
// ⚠️ READ THIS FIRST. LinkedIn polices automation harder than any other channel here: the User
// Agreement (8.2) prohibits bots and scripts outright, and accounts caught running them get
// restricted. A LinkedIn account is usually someone's real professional identity, so the cost
// of a restriction is not symmetric with the benefit of a few follows. Consequently:
//   - the defaults here are far more conservative than follow-core's — `--max 5` and a
//     60–180s delay (explicit flags still win),
//   - a non-dry run prints the risk to stderr before it starts,
//   - and `--dry-run` is the mode you should normally use.
//
// Auth — the `li_at` cookie alone gets 403 "CSRF check failed" on Voyager. It needs the
// **JSESSIONID cookie as well** (its value already contains quotes: `"ajax:<digits>"`) plus a
// `csrf-token` header holding that same value **with the quotes stripped**. Cookie header keeps
// the quotes, csrf-token header does not.
//
// Reading followers/following — the paginated API the My Network page hits while scrolling is
// far cleaner than its server-rendered first page, and works browserless:
//   GET https://www.linkedin.com/voyager/api/graphql?variables=(start:<N>,count:10,
//     origin:CurationHub,query:(flagshipSearchIntent:MYNETWORK_CURATION_HUB,
//     includeFiltersInResponse:true,queryParameters:List((key:resultType,
//     value:List(<FOLLOWERS|PEOPLE_FOLLOW>)))))&queryId=<queryId>
// resultType is `FOLLOWERS` for your followers and **`PEOPLE_FOLLOW`** for the people you
// follow (not the symmetric-sounding "FOLLOWING" — that was captured from the real page, not
// guessed). Send the query parameters unencoded, parentheses and colons raw, as the browser does.
//
// Parsing — `included` mixes types. `EntityResultViewModel` is one per person and carries
// `primaryActions[0].actionDetails['*followAction']` =
// `urn:li:fsd_followingState:urn:li:fsd_profile:<profileId>`, and that profileId is the
// targetId the follow write needs. `FollowingState` entries share that URN and carry
// `following` — your own relationship state, which is more trustworthy than a set difference.
// A follow-back candidate is a follower whose `following === false`.
//
// Follow WRITE:
//   POST /voyager/api/feed/dash/followingStates/urn:li:fsd_followingState:urn:li:fsd_profile:<id>
//   body: {"patch":{"$set":{"following":true}}} · header: csrf-token
// Default transport is plain fetch; `--cdp` runs the same call inside a logged-in page instead,
// which leaves the browser's own fingerprint (sec-fetch-*, referer) on the request. Neither is
// required by the server — the in-page path is a safety margin, not a technical necessity.
// **A 200 is not proof**: the same URL is GET-able and returns the current FollowingState, so
// every write is confirmed by re-reading it, and an unconfirmed write is recorded as such.
// A **405** is a definitive refusal for that target (a minority of targets answer it, and they
// answer it every time) — recorded as `blocked` so later runs stop re-firing a refused write,
// which is exactly the pattern abuse detection looks for.
//
// follow-likers uses the legacy Voyager REST collection — no GraphQL queryId needed:
//   GET /voyager/api/feed/reactions?count=50&q=reactionType&start=<N>&threadUrn=<activityUrn>
// `included` pairs a Reaction with a `MiniProfile`, whose `dashEntityUrn` is the same
// `urn:li:fsd_profile:<id>` format the write takes. `data.paging.total` is authoritative, and
// **company-page reactions are counted and skipped** (different URN scheme, not followable
// here). Posts come from the ledger's `activityUrn`.
//
// usage: node follow.mjs (--follow-back|--follow-likers) [--dry-run] [--max N]
//        [--delay-min S] [--delay-max S] [--posts N] [--cdp]

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { resolveCookie } from '../lib/site-cookie.mjs';
import { loadEnv, home, dataPath, cdpPort } from '../lib/env.mjs';
import { blockedIds, followedIds, parseFollowArgs, runFollows, warnRealRun } from '../lib/follow-core.mjs';

loadEnv();

const CHANNEL = 'linkedin';
const ENV_PATH = path.join(home(), '.env');
const PORT = cdpPort();
// A dedicated env key: LINKEDIN_COOKIE (shared by post-api/stats-fast) holds li_at only, and
// persisting two cookies under it would break those callers' assumption.
const COOKIE_KEY = 'LINKEDIN_FOLLOW_COOKIE';
const COOKIE_NAMES = ['li_at', 'JSESSIONID'];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const PAGE_SIZE = 10;
const MAX_PAGES = 60;   // backstop (60 × 10 = 600 people)
const QUERY_ID = process.env.LINKEDIN_SEARCH_QUERY_ID
  || 'voyagerSearchDashClusters.a7a0567fa66c52d645b5ff2f960b92aa';
const PUBLISHED = dataPath('ledgers/published-linkedin.json'); // posts to read reactors from
const REACTION_PAGE = 50;
const MAX_REACTION_PAGES = 20;

function csrfFromCookie(cookie) {
  const m = cookie.match(/JSESSIONID=("?)([^;]+)\1/);
  return m ? m[2].replace(/^"|"$/g, '') : null; // header wants it unquoted
}

function classify(status, text, label) {
  const fatal = status === 401 || status === 403 || status === 429;
  const err = new Error(`${label} HTTP ${status}: ${(text || '').slice(0, 160)}`);
  if (fatal) err.fatal = true;
  // 405 = this target refuses the write, every time. Left as a retryable failure the ledger
  // would not stop the next run from firing the same refused write again.
  // **Do not read it as the endpoint being blocked outright** — the same code succeeds on most
  // targets. It is per-target, so it is not fatal: skip this one, continue the batch.
  if (status === 405) err.blocked = true;
  return err;
}

const voyagerHeaders = (cookie, csrf) => ({
  cookie,
  'user-agent': UA,
  'x-restli-protocol-version': '2.0.0',
  'csrf-token': csrf,
  accept: 'application/vnd.linkedin.normalized+json+2.1',
});

async function graphqlSearch(cookie, csrf, resultType, start) {
  const url = `https://www.linkedin.com/voyager/api/graphql?variables=(start:${start},count:${PAGE_SIZE},origin:CurationHub,query:(flagshipSearchIntent:MYNETWORK_CURATION_HUB,includeFiltersInResponse:true,queryParameters:List((key:resultType,value:List(${resultType})))))&queryId=${QUERY_ID}`;
  const res = await fetch(url, { headers: voyagerHeaders(cookie, csrf) });
  const text = await res.text();
  if (res.status !== 200) throw classify(res.status, text, `${resultType} search`);
  try { return JSON.parse(text); } catch { throw new Error(`${resultType} returned unparseable data: ${text.slice(0, 160)}`); }
}

// resultType = 'FOLLOWERS' | 'PEOPLE_FOLLOW'. Returns {profileId, name, following}[].
//
// The only termination condition is `start < totalResultCount`. "A short batch means the end"
// is a false signal — a middle page can come back with 9 entries and the next pages still hold
// data. An empty batch is kept as a backstop against a wrong total.
async function listPeople(cookie, csrf, resultType) {
  const out = [];
  let start = 0;
  let total = Infinity;
  for (let i = 0; i < MAX_PAGES && start < total; i++) {
    const data = await graphqlSearch(cookie, csrf, resultType, start);
    const meta = data?.data?.data?.searchDashClustersByAll?.metadata;
    if (meta?.totalResultCount != null) total = meta.totalResultCount;
    const included = data.included || [];
    const followingByUrn = new Map();
    for (const e of included) {
      if (e['$type'] === 'com.linkedin.voyager.dash.feed.FollowingState') followingByUrn.set(e.entityUrn, e.following);
    }
    let batchCount = 0;
    for (const e of included) {
      if (e['$type'] !== 'com.linkedin.voyager.dash.search.EntityResultViewModel') continue;
      batchCount++;
      const followUrn = e.primaryActions?.[0]?.actionDetails?.['*followAction'];
      if (!followUrn) continue; // entries with a different action type carry no follow state
      const profileId = followUrn.split(':').pop();
      out.push({ profileId, name: e.title?.text || profileId, following: followingByUrn.get(followUrn) ?? null });
    }
    if (!batchCount) break;
    start += PAGE_SIZE;
  }
  return out;
}

// Your own profile id, so you cannot end up as a candidate on your own post. Failure is not
// fatal — it only costs the self-exclusion.
async function myProfileId(cookie, csrf) {
  const res = await fetch('https://www.linkedin.com/voyager/api/me', { headers: voyagerHeaders(cookie, csrf) });
  if (res.status !== 200) return null;
  const m = (await res.text()).match(/urn:li:fsd_profile:([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// Reactors of one post, [{profileId, name}], paginated by paging.total.
//
// The expected head-count is NOT paging.total — it is the number of member reactions in
// `data['*elements']`. Company pages react too, and they arrive as MiniCompany with no
// MiniProfile at all, so a post liked only by a company would trip a naive "total > 0 but zero
// profiles" guard. Companies are skipped and counted. When members ARE expected and none parse,
// that IS a structural change and it throws — folding it into "0 likes" would report no
// candidates forever while looking perfectly healthy.
async function listReactors(cookie, csrf, activityUrn) {
  const out = [];
  let start = 0;
  let total = Infinity;
  let seenTotal = null;
  let expectedMembers = 0;
  let companies = 0;
  for (let i = 0; i < MAX_REACTION_PAGES && start < total; i++) {
    const url = `https://www.linkedin.com/voyager/api/feed/reactions?count=${REACTION_PAGE}&q=reactionType&start=${start}&threadUrn=${encodeURIComponent(activityUrn)}`;
    const res = await fetch(url, { headers: voyagerHeaders(cookie, csrf) });
    const text = await res.text();
    if (res.status !== 200) throw classify(res.status, text, `reactions ${activityUrn}`);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`reactions returned unparseable data: ${text.slice(0, 160)}`); }
    const paging = data?.data?.paging;
    if (paging?.total != null) { total = paging.total; seenTotal = paging.total; }
    const elements = data?.data?.['*elements'] || [];
    for (const u of elements) {
      if (String(u).includes('urn:li:member:')) expectedMembers++;
      else if (String(u).includes('urn:li:company:')) companies++;
    }
    for (const e of data.included || []) {
      if (e['$type'] !== 'com.linkedin.voyager.identity.shared.MiniProfile') continue;
      const profileId = String(e.dashEntityUrn || '').split(':').pop();
      if (!profileId) continue;
      out.push({ profileId, name: [e.firstName, e.lastName].filter(Boolean).join(' ') || profileId });
    }
    // Stop on an empty page (guards against a wrong total). Elements, not MiniProfiles — a page
    // holding only company reactions is not an empty page.
    if (!elements.length) break;
    start += REACTION_PAGE;
  }
  if (seenTotal == null) throw new Error(`reactions ${activityUrn}: no paging.total — the response shape probably changed`);
  if (expectedMembers > 0 && out.length === 0) {
    throw new Error(`reactions ${activityUrn}: ${expectedMembers} member reaction(s) but no profiles parsed — treating as a read failure`);
  }
  if (companies) console.error(`  ↳ ${activityUrn}: skipped ${companies} company-page reaction(s) — different URN scheme, not followable here`);
  return out;
}

function recentActivityUrns(postCount) {
  if (!existsSync(PUBLISHED)) return [];
  let ledger;
  try { ledger = JSON.parse(readFileSync(PUBLISHED, 'utf8')); } catch { return []; }
  return (Array.isArray(ledger) ? ledger : Object.values(ledger))
    .filter((e) => e && e.activityUrn)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, postCount)
    .map((e) => e.activityUrn);
}

// Reactors of the most recent --posts posts, deduped by profileId. One post failing skips only
// that post — but it is reported, never swallowed.
async function likerCandidates(cookie, csrf, postCount) {
  const urns = recentActivityUrns(postCount);
  const byId = new Map();
  let read = 0;
  for (const urn of urns) {
    let people;
    try { people = await listReactors(cookie, csrf, urn); } catch (e) {
      console.error(`  ↳ [skip] ${urn}: ${e.message}`);
      if (e.fatal) throw e; // 401/403/429 will block the remaining posts the same way
      continue;
    }
    read++;
    for (const p of people) {
      if (!byId.has(p.profileId)) byId.set(p.profileId, { ...p, srcPost: urn });
    }
  }
  console.error(`  ↳ posts=${urns.length} read-ok=${read} reactors(unique)=${byId.size}`);
  return [...byId.values()];
}

const followUrl = (profileId) =>
  `https://www.linkedin.com/voyager/api/feed/dash/followingStates/urn:li:fsd_followingState:urn:li:fsd_profile:${profileId}`;

async function followUserBrowserless(cookie, csrf, profileId) {
  const url = followUrl(profileId);
  const headers = voyagerHeaders(cookie, csrf);
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ patch: { $set: { following: true } } }),
  });
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) throw classify(res.status, text, `follow ${profileId}`);

  // A POST 200 is not the proof — re-read the state.
  const check = await fetch(url, { headers });
  let confirmed = false;
  if (check.status === 200) {
    try { confirmed = JSON.parse(await check.text())?.data?.following === true; } catch { /* leave false */ }
  }
  if (!confirmed) {
    const err = new Error(`follow ${profileId}: POST ${res.status} succeeded but the re-read did not show following:true (HTTP ${check.status})`);
    err.unconfirmed = true;
    throw err;
  }
}

// Same call from inside a logged-in linkedin.com page (the `--cdp` path), so the request carries
// the browser's own headers. The page must be on linkedin.com — the csrf token is derived from
// document.cookie there.
async function followUserInPage(page, profileId) {
  const url = followUrl(profileId);
  const call = (method, body) => page.evaluate(async ({ u, method, body }) => {
    const m = document.cookie.match(/JSESSIONID=("?)([^;]+)\1/);
    const csrf = m ? m[2].replace(/^"|"$/g, '') : '';
    try {
      const r = await fetch(u, {
        method,
        credentials: 'include',
        headers: {
          'csrf-token': csrf,
          'x-restli-protocol-version': '2.0.0',
          accept: 'application/vnd.linkedin.normalized+json+2.1',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body,
      });
      return { status: r.status, text: await r.text().catch(() => '') };
    } catch (e) { return { status: 0, text: String((e && e.message) || e) }; }
  }, { u: url, method, body });

  const res = await call('POST', JSON.stringify({ patch: { $set: { following: true } } }));
  if (res.status < 200 || res.status >= 300) throw classify(res.status, res.text, `follow ${profileId}`);

  const check = await call('GET', undefined);
  let confirmed = false;
  if (check.status === 200) {
    try { confirmed = JSON.parse(check.text)?.data?.following === true; } catch { /* leave false */ }
  }
  if (!confirmed) {
    const err = new Error(`follow ${profileId}: POST ${res.status} succeeded but the re-read did not show following:true (HTTP ${check.status})`);
    err.unconfirmed = true;
    throw err;
  }
}

const describe = (c) => `${c.handle} (${c.targetId})`;

async function main() {
  const rawArgs = process.argv;
  const hasFlag = (f) => rawArgs.includes(f);
  const parsed = parseFollowArgs(rawArgs, { max: 5, delayMin: 60, delayMax: 180 });
  const { mode, dryRun, posts } = parsed;
  const { max, delayMin, delayMax } = parsed;

  if (!dryRun) {
    warnRealRun(
      CHANNEL,
      'LinkedIn prohibits automation in its User Agreement (8.2) and restricts accounts that use it — this is the riskiest channel here.',
    );
  }

  const { cookie, src } = await resolveCookie({
    key: COOKIE_KEY, envPath: ENV_PATH, port: PORT,
    origins: ['https://www.linkedin.com'], names: COOKIE_NAMES, chromium,
    // JSESSIONID's value contains quotes, and the simple quote-delimited .env round trip
    // truncates it at the first inner quote. Rather than change the shared cookie helper, this
    // validate insists the stored value still parses — a truncated one is rejected and
    // re-captured over CDP (one extra round trip, in exchange for never running with a broken
    // csrf token).
    validate: async (c) => !!csrfFromCookie(c),
  });
  console.error(`cookie src: ${src}`);
  const csrf = csrfFromCookie(cookie);
  if (!csrf) throw new Error('no JSESSIONID cookie — the Voyager calls cannot be made without a CSRF token');

  const ledgerIds = followedIds(CHANNEL);
  const refused = blockedIds(CHANNEL); // 405-refused targets — retrying them is probing

  let via, candidates;
  if (mode === 'follow-back') {
    via = 'follow-back';
    const [followers, following] = await Promise.all([
      listPeople(cookie, csrf, 'FOLLOWERS'),
      listPeople(cookie, csrf, 'PEOPLE_FOLLOW'),
    ]);
    console.error(`  ↳ followers=${followers.length} following=${following.length}`);
    candidates = followers
      .filter((f) => f.following === false && !ledgerIds.has(f.profileId) && !refused.has(f.profileId))
      .map((f) => ({ targetId: f.profileId, handle: f.name }));
  } else {
    via = 'liker';
    // Unlike follow-back, the reactions response carries no per-target FollowingState — read
    // your following list separately and take the difference.
    const [reactors, following] = await Promise.all([
      likerCandidates(cookie, csrf, posts),
      listPeople(cookie, csrf, 'PEOPLE_FOLLOW'),
    ]);
    const me = await myProfileId(cookie, csrf);
    if (!me) console.error('  ↳ warning: /voyager/api/me failed — continuing without self-exclusion');
    const followingIds = new Set(following.map((f) => f.profileId));
    console.error(`  ↳ following=${followingIds.size}`);
    candidates = reactors
      .filter((r) => r.profileId !== me && !followingIds.has(r.profileId)
        && !ledgerIds.has(r.profileId) && !refused.has(r.profileId))
      .map((r) => ({ targetId: r.profileId, handle: r.name, srcPost: r.srcPost }));
  }
  if (refused.size) console.error(`  ↳ excluded ${refused.size} target(s) previously refused with 405`);

  if (dryRun) {
    await runFollows({ channel: CHANNEL, candidates, via, dryRun, max, delayMin, delayMax, follow: async () => {}, describe });
    return;
  }

  if (!hasFlag('--cdp')) {
    await runFollows({
      channel: CHANNEL, candidates, via, dryRun, max, delayMin, delayMax,
      follow: (profileId) => followUserBrowserless(cookie, csrf, profileId),
      describe,
    });
    return;
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { noDefaults: true });
  try {
    const ctx = browser.contexts()[0];
    const page = ctx.pages().find((p) => p.url().includes('linkedin.com')) || ctx.pages()[0] || (await ctx.newPage());
    await page.bringToFront().catch(() => {});
    if (!page.url().includes('linkedin.com')) {
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await runFollows({
      channel: CHANNEL,
      candidates,
      via,
      dryRun,
      max,
      delayMin,
      delayMax,
      follow: (profileId) => followUserInPage(page, profileId),
      describe,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
