#!/usr/bin/env node
// Facebook auto-follow — follow-back (people who follow you and you don't follow) and
// follow-likers (people who reacted to your Page's posts). The follow target is your **personal
// profile** (`FACEBOOK_PROFILE`), not the Page: a Page cannot follow people.
//
// ⚠️ Meta polices follow automation hard. Defaults here are therefore much more conservative
// than follow-core's — `--max 3` and a 90–300s delay — and a non-dry run prints a warning.
// Treat `--dry-run` as the normal mode.
//
// **Your personal profile needs professional mode for public followers to exist at all.**
// Without it Facebook offers only "friends" as the audience and there is no follower list to
// read. Turning it on (Settings → Followers and public content) is reversible.
// **Do not read the follower COUNT as candidates**: in professional mode the count includes
// friends, but the follower LIST shows only genuine public followers — a fresh switch legitimately
// yields zero candidates while the header shows hundreds.
//
// Reading — the followers tab is DOM-scraped. Three traps, all measured:
//   1) `a[href*="profile.php?id="]` also matches global notification cards (their href carries
//      `notif_id=`/`notif_t=`) and profile intro tags, none of which belong to the list.
//   2) `id=` renders empty before hydration, so the page is loaded to `networkidle`.
//   3) The usable signal: a real follower row renders the same id at least twice (name link +
//      mutual-friends sublink), while notification cards and intro tags appear exactly once.
//   **Known limitation**: this matches only `profile.php?id=<digits>` profiles. Accounts with a
//   custom username are missed entirely. Nothing is truncated silently — what is recovered is
//   what is reported.
//
// Follow WRITE — the real "follow" button is clicked in-page. The underlying GraphQL mutation
// (`CometUserFollowMutation`) carries per-page-load anti-abuse tokens in its body, so it cannot
// be reassembled by hand. Confirmation opens the profile again in a **brand new tab** (not a
// reload — client state after a click is optimistic and not evidence) and looks for the
// unfollow-style label. Facebook labels the followed state "unfollow", unlike the other channels.
//
// follow-likers reads the Page's reactions with the Graph API (browserless, same token as
// stats.mjs):
//   GET /v21.0/<postId>?fields=reactions.summary(true).limit(<n>){id,name,type}
// The reactor `id` is app/page-scoped, and whether `profile.php?id=<that id>` opens is unverified
// — `filterActionable()` opens each candidate's profile **before any write** and drops the ones
// with no follow button, so an unusable id becomes "no candidate" rather than a bad write.
//
// Accepting friend requests is a different relationship and lives in accept-requests.mjs.
//
// explore (cold discovery) renders an arbitrary profile or page's /followers (or /following) tab
// and mines it. Facebook is the one channel with NO quality signal in the listing — no follower
// count, no post count — so the only filter before a write is filterActionable(), which opens
// each shortlisted profile and looks at its buttons.
//
// usage: node follow.mjs (--follow-back|--follow-likers|--follow-explore) [--dry-run] [--max N]
//        [--delay-min S] [--delay-max S] [--posts N]
//        explore only: [--seed <slug-or-id> …] [--seed-side followers|following]
// Requires a logged-in Facebook session in the shared CDP browser.

import { readFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { loadEnv, dataPath, cdpPort } from '../lib/env.mjs';
import { followedIds, parseFollowArgs, runFollows, warnRealRun } from '../lib/follow-core.mjs';
import { seedsFor, seedSideFor, interleaveBySeed } from '../lib/follow-seeds.mjs';

loadEnv();

const CHANNEL = 'facebook';
const GRAPH = 'https://graph.facebook.com/v21.0';
const PUBLISHED = dataPath('ledgers/published-facebook.json'); // posts to read reactions from
const REACTION_LIMIT = 100;
const PORT = cdpPort();
const PROFILE = process.env.FACEBOOK_PROFILE; // your personal profile slug or numeric id
const FOLLOWERS_URL = PROFILE ? `https://www.facebook.com/${PROFILE}/followers` : null;
// DOM matchers, not user-facing copy — these are the labels Facebook renders in the interface
// language of the logged-in session. Translating them breaks the click; override them instead.
const LABEL_FOLLOW = process.env.FACEBOOK_FOLLOW_LABEL || '팔로우';
const LABEL_UNFOLLOW = process.env.FACEBOOK_UNFOLLOW_LABEL || '팔로우 취소';
const LABEL_MUTUAL = process.env.FACEBOOK_MUTUAL_FRIENDS_LABEL || '함께 아는';
// Facebook alternates between these two on a followed profile depending on context, so the
// confirmation matches EITHER. Pinning one of them makes real follows read as unconfirmed, and an
// unconfirmed follow is not deduped — the next run fires the same write at somebody already
// followed, which is exactly the pattern abuse detection looks for.
const LABEL_FOLLOWING = process.env.FACEBOOK_FOLLOWING_LABEL || '팔로잉';
// Friendship is a separate axis: a friend's profile can show a follow button too. Those are
// excluded from explore — they are not accounts you have no connection to, and a friend profile
// surfaces no following/unfollow label at all, so a follow there can never be confirmed.
const LABEL_FRIEND = process.env.FACEBOOK_FRIEND_LABEL || '친구';

// A profile opens by numeric id or by custom username, and in practice most accounts have a
// username — a numeric-only implementation silently drops the majority of what it finds.
const profileUrl = (id) => (/^\d+$/.test(String(id))
  ? `https://www.facebook.com/profile.php?id=${id}`
  : `https://www.facebook.com/${id}`);

// Facebook's own routes come back from href scraping looking like people ("Log in", "Sign up").
// They get filtered out by the follow-button check anyway, but they consume a slot in it and make
// the preview table untrustworthy.
const SYSTEM_SLUGS = new Set(['l.php', 'login.php', 'signup', 'sharer.php', 'story.php', 'privacy',
  'policies', 'help', 'settings', 'bookmarks', 'friends', 'groups', 'watch', 'marketplace',
  'events', 'pages', 'profile.php', 'search', 'notes', 'gaming', 'ads', 'business']);

// Reading the followers tab. `page.evaluate` runs in the page, so the labels are passed in.
async function listFollowers(ctx) {
  const page = await ctx.newPage();
  try {
    await page.goto(FOLLOWERS_URL, { waitUntil: 'networkidle', timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const rows = await page.evaluate((mutualLabel) => {
      const myId = document.querySelector('a[href*="fb_profile_edit_entry_point"]')?.getAttribute('href')?.match(/[?&]id=(\d+)/)?.[1] || null;
      const byPk = new Map();
      for (const a of document.querySelectorAll('a[href*="profile.php?id="]')) {
        const href = a.getAttribute('href');
        if (/notif_id=|notif_t=/.test(href)) continue; // notification card, not a follower row
        const m = href.match(/[?&]id=(\d+)/);
        if (!m || m[1] === myId) continue;
        const pk = m[1];
        const name = (a.textContent || '').trim();
        const entry = byPk.get(pk) || { pk, name: '', count: 0 };
        entry.count += 1;
        if (name && name.length < 40 && !name.includes(mutualLabel)) entry.name = name;
        byPk.set(pk, entry);
      }
      return [...byPk.values()].filter((e) => e.count >= 2 && e.name);
    }, LABEL_MUTUAL);
    return rows.map(({ pk, name }) => ({ pk, name }));
  } finally {
    await page.close().catch(() => {});
  }
}

async function followUser(ctx, { pk, name }) {
  const page = await ctx.newPage();
  try {
    await page.goto(profileUrl(pk), { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2000);
    const clicked = await page.evaluate((label) => {
      const el = [...document.querySelectorAll('div[role=button]')].find((b) => (b.textContent || '').trim() === label);
      if (el) { el.click(); return true; }
      return false;
    }, LABEL_FOLLOW);
    if (!clicked) throw new Error(`${name}(${pk}): no follow button (already following, or the page structure changed)`);
    await page.waitForTimeout(2000);
  } finally {
    await page.close().catch(() => {});
  }

  // Confirm in a brand new tab — the clicked document's own state is optimistic client render.
  const confirmPage = await ctx.newPage();
  let confirmed = false;
  let seen = [];
  try {
    await confirmPage.goto(profileUrl(pk), { waitUntil: 'domcontentloaded', timeout: 25000 });
    await confirmPage.waitForTimeout(2000);
    seen = await confirmPage.evaluate(
      () => [...document.querySelectorAll('div[role=button]')].map((b) => (b.textContent || '').trim()).filter((t) => t && t.length < 20),
    );
    confirmed = seen.includes(LABEL_UNFOLLOW) || seen.includes(LABEL_FOLLOWING);
  } finally {
    await confirmPage.close().catch(() => {});
  }
  if (!confirmed) {
    // Report the labels that WERE there. "unconfirmed" on its own sends the next reader hunting
    // selectors, while the usual cause is the relationship state (a friend's profile shows
    // neither label). The authoritative check is your own /following list, not this page.
    const err = new Error(
      `${name}(${pk}): the re-opened profile does not show the followed state (buttons: ${seen.slice(0, 5).join(' / ') || 'none'}) — ` +
      'verify against facebook.com/<you>/following before assuming it failed',
    );
    err.unconfirmed = true;
    throw err;
  }
}

// Reactors of the most recent --posts Page posts, [{pk, name, srcPost}]. Graph API, browserless.
// **A positive total with an empty data array throws** — folding it into "no reactions" would
// report zero candidates forever while looking healthy (same guard as the other readers).
async function likerCandidates(postCount) {
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error('FACEBOOK_PAGE_ACCESS_TOKEN is not set — run get-page-token.mjs first');
  let ledger = [];
  if (existsSync(PUBLISHED)) {
    try { ledger = JSON.parse(readFileSync(PUBLISHED, 'utf8')); } catch { ledger = []; }
  }
  const posts = (Array.isArray(ledger) ? ledger : Object.values(ledger))
    .filter((e) => e && e.id)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, postCount);

  const byId = new Map();
  let totalReactions = 0;
  let read = 0;
  for (const p of posts) {
    const url = `${GRAPH}/${p.id}?fields=reactions.summary(true).limit(${REACTION_LIMIT}){id,name,type}&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (body.error) {
      console.error(`  ↳ [skip] ${p.id}: ${body.error.message}`);
      continue;
    }
    read++;
    const total = body.reactions?.summary?.total_count ?? 0;
    const data = body.reactions?.data || [];
    if (total > 0 && data.length === 0) {
      throw new Error(`reactions ${p.id}: total_count=${total} but no reactor data — treating as a read failure`);
    }
    totalReactions += total;
    for (const u of data) {
      if (u.id && !byId.has(u.id)) byId.set(u.id, { pk: u.id, name: u.name || u.id, srcPost: p.id });
    }
  }
  console.error(`  ↳ read ${read}/${posts.length} posts · ${totalReactions} reactions · ${byId.size} unique reactors`);
  return [...byId.values()];
}

// Open each candidate's profile without writing anything and keep only the ones that actually
// offer a follow button. Following and friending are different relationships: a pending friend
// request can leave a profile with no follow button at all, and the follower list cannot tell.
// This is also why the channel never records `blocked` — an unfollowable target is dropped
// before any write, so there is no refused write to remember.
async function filterActionable(ctx, rawCandidates) {
  const out = [];
  for (const c of rawCandidates) {
    const page = await ctx.newPage();
    try {
      await page.goto(profileUrl(c.pk), { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(1500);
      const labels = await page.evaluate(
        () => [...document.querySelectorAll('div[role=button]')].map((b) => (b.textContent || '').trim()).filter((t) => t && t.length < 20),
      );
      const hasFollow = labels.includes(LABEL_FOLLOW);
      const isFriend = labels.includes(LABEL_FRIEND);
      if (hasFollow && !isFriend) out.push(c);
      else if (isFriend) console.error(`  ↳ skipped: ${c.name} (${c.pk}) — already a friend (a follow there cannot be confirmed, and it is not a cold contact)`);
      else console.error(`  ↳ skipped: ${c.name} (${c.pk}) — no follow button (a pending friend request or another relationship state); buttons seen: ${labels.slice(0, 5).join(' / ') || 'none'}`);
    } finally {
      await page.close().catch(() => {});
    }
  }
  return out;
}

// --- explore: mine a seed account's followers (or following) tab ---
// Rows are scraped from hrefs because there is no API for this: the Graph endpoints for a page's
// followers are either permission-denied or nonexistent fields on the new page experience.
// Both href shapes matter — `profile.php?id=<n>` and `/<username>` — and a numeric-only parse
// drops most of what a real followers tab contains.
async function listNeighbours(ctx, seed, side) {
  const page = await ctx.newPage();
  try {
    await page.goto(`https://www.facebook.com/${seed}/${side}`, { waitUntil: 'networkidle', timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(2500);
    for (let i = 0; i < 3; i++) { // one screenful is ~10 rows; a few scrolls is enough for --max
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
      await page.waitForTimeout(1200);
    }
    const rows = await page.evaluate((mutualLabel) => {
      const byId = new Map();
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        if (/notif_id=|notif_t=/.test(href)) continue;
        let id = null;
        const num = href.match(/profile\.php\?id=(\d+)/);
        if (num) id = num[1];
        else {
          const rel = href.match(/^(?:https:\/\/www\.facebook\.com)?\/([A-Za-z0-9.]{4,50})\/?(?:\?|$)/);
          if (rel) id = rel[1];
        }
        if (!id) continue;
        const name = (a.textContent || '').trim();
        const e = byId.get(id) || { id, name: '', count: 0 };
        e.count += 1;
        if (name && name.length < 40 && !name.includes(mutualLabel)) e.name = name;
        byId.set(id, e);
      }
      return [...byId.values()];
    }, LABEL_MUTUAL);
    return rows.filter((r) => r.name && !SYSTEM_SLUGS.has(r.id));
  } finally {
    await page.close().catch(() => {});
  }
}

const describe = (c) => `${c.handle} (${c.targetId})${c.seed ? ` [seed ${c.seed}]` : ''}`;

async function main() {
  const parsed = parseFollowArgs(process.argv, { max: 3, delayMin: 90, delayMax: 300, explore: true });
  const { mode, dryRun, max, delayMin, delayMax, posts, seeds, seedSide } = parsed;

  if (mode === 'follow-back' && !PROFILE) {
    console.error('FACEBOOK_PROFILE is not set — follow-back needs your personal profile slug or id (the Page cannot follow people).');
    process.exit(1);
  }
  if (!dryRun) {
    warnRealRun(
      CHANNEL,
      'Meta polices follow automation more aggressively than any other channel here.' +
      (mode === 'explore' ? ' Explore targets have no prior connection to you — this is cold outreach.' : ''),
    );
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { noDefaults: true });
  try {
    const ctx = browser.contexts()[0];
    const ledgerIds = followedIds(CHANNEL);

    let via, rawCandidates;
    if (mode === 'explore') {
      via = 'explore';
      const side = seedSideFor(CHANNEL, seedSide) === 'following' ? 'following' : 'followers';
      const seedList = seedsFor(CHANNEL, seeds);
      const bySeed = new Map();
      for (const s of seedList) {
        let rows;
        try { rows = await listNeighbours(ctx, s.id, side); } catch (e) {
          console.error(`  ↳ [skip] seed ${s.id}: ${e.message}`);
          continue;
        }
        const kept = rows.filter((r) => !ledgerIds.has(r.id)).map((r) => ({ pk: r.id, name: r.name, seed: s.id }));
        console.error(`  ↳ seed ${s.id}/${side}: ${rows.length} row(s) · ${kept.length} candidate(s)`);
        bySeed.set(s.id, kept);
      }
      if (!bySeed.size) throw new Error('every seed failed to load — nothing was explored (this is not "no candidates").');
      // A seed's followers tab yields far more rows than any run will use, and filterActionable
      // costs a page load each. Check a small multiple of the cap and say how many were left.
      const all = interleaveBySeed(bySeed);
      const budget = Math.max(max * 4, 8);
      rawCandidates = all.slice(0, budget);
      if (all.length > rawCandidates.length) {
        console.error(`  ↳ checking ${rawCandidates.length} of ${all.length} candidate(s) for a follow button (budget = --max × 4)`);
      }
    } else if (mode === 'follow-back') {
      via = 'follow-back';
      const followers = await listFollowers(ctx);
      console.error(`  ↳ followers listed=${followers.length} (professional mode counts friends in the total but never lists them — zero here is normal)`);
      rawCandidates = followers.filter((f) => !ledgerIds.has(f.pk));
    } else {
      via = 'liker';
      const likers = await likerCandidates(posts);
      rawCandidates = likers.filter((u) => !ledgerIds.has(u.pk));
    }
    const actionable = await filterActionable(ctx, rawCandidates);
    const candidates = actionable.map((f) => ({ targetId: f.pk, handle: f.name, srcPost: f.srcPost, seed: f.seed }));

    if (dryRun) {
      await runFollows({ channel: CHANNEL, candidates, via, dryRun, max, delayMin, delayMax, follow: async () => {}, describe });
      return;
    }

    await runFollows({
      channel: CHANNEL,
      candidates,
      via,
      dryRun,
      max,
      delayMin,
      delayMax,
      follow: (pk) => {
        const target = candidates.find((c) => c.targetId === pk);
        return followUser(ctx, { pk, name: target.handle });
      },
      describe,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
