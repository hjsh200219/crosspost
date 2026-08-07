// Channel-agnostic core for the auto-follow tools (follow-back / follow-likers / explore).
//
// A channel script (scripts/<channel>/follow.mjs) owns the platform calls — auth, listing
// followers/following/likers, the actual follow write — and hands candidates to runFollows()
// here, which owns the parts that must behave the same everywhere: dedup against a ledger,
// capping, dry-run, the delay between follows, and per-candidate bookkeeping. Split this way,
// a new channel reuses the safety behavior instead of re-implementing it slightly differently.
//
// Ledger: $CROSSPOST_HOME/ledgers/follows-<channel>.json, alongside published-<channel>.json.
// A corrupt ledger fails closed (exit 1) rather than being read as empty — reading it as empty
// would re-follow accounts already recorded as followed, and that is not reversible from here.
//
// READ THIS BEFORE ENABLING IT ANYWHERE: automated following is against the terms of service
// of most platforms, and the ones that police it hardest (LinkedIn and the three Meta
// surfaces) can restrict or disable an account for it. Every channel here defaults to a small
// cap and a long delay for that reason, and a non-dry run prints a warning naming the risk.
// Treat --dry-run as the normal mode and a real run as a deliberate act.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { dataPath } from './env.mjs';

export function ledgerPath(channel) {
  return dataPath(`ledgers/follows-${channel}.json`);
}

function loadLedger(channel) {
  const p = ledgerPath(channel);
  let text;
  try {
    text = readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return []; // no ledger yet — first run, not corruption
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    // Fail closed: falling back to an empty ledger would make runFollows() think nobody has
    // been followed yet and re-follow everyone recorded in the file.
    console.error(
      `follow-core: ${p} exists but is not valid JSON — refusing to treat it as empty ` +
      `(that would re-follow accounts already recorded). Fix or move the file, then retry.\n  ${e.message}`,
    );
    process.exit(1);
  }
}

/** targetIds already recorded as 'followed'. Only 'followed' counts — a dry-run preview must
 *  never suppress a real follow attempted later (dry-run writes nothing at all, see
 *  runFollows), and a 'failed' attempt has to stay retryable rather than count as done. */
export function followedIds(channel) {
  const ids = new Set();
  for (const e of loadLedger(channel)) {
    if (e && e.targetId != null && e.status === 'followed') ids.add(String(e.targetId));
  }
  return ids;
}

/** targetIds the platform has definitively refused ('blocked'), so retrying is pointless and
 *  looks like probing. Distinct from 'failed' (retryable: network blip, transient 5xx) — a
 *  channel opts a target in by throwing with `.blocked = true`, which it should do only for a
 *  server answer meaning "this target cannot be followed by this call", never "it didn't work
 *  right now". Kept separate from followedIds because these are NOT followed: counting them as
 *  done would inflate any follow tally read off the ledger.
 *
 *  Precedent: the LinkedIn follow write answers 405 for a minority of targets, and the same
 *  target repeats it indefinitely. Left as 'failed' those targets stayed candidates forever and
 *  every run re-fired the same refused write — exactly the shape abuse detection looks for. */
export function blockedIds(channel) {
  const ids = new Set();
  for (const e of loadLedger(channel)) {
    if (e && e.targetId != null && e.status === 'blocked') ids.add(String(e.targetId));
  }
  return ids;
}

/** Append one follow attempt to the channel's follow ledger. */
export function recordFollow(channel, entry) {
  const ledger = loadLedger(channel);
  ledger.push({
    targetId: entry.targetId,
    handle: entry.handle,
    via: entry.via,
    srcPost: entry.srcPost ?? null,
    status: entry.status,
    ts: entry.ts || new Date().toISOString(),
  });
  const p = ledgerPath(channel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(ledger, null, 2)}\n`);
}

/** Default cap for explore, deliberately far below the other modes'.
 *
 *  follow-back and follow-likers act on people who already reached for you, and in practice they
 *  produce single-digit candidate counts. Explore is cold outreach into somebody else's audience
 *  and produces hundreds. The cap is close to the only thing standing between a typo and a few
 *  hundred unsolicited follows, so it starts at 3 and is raised deliberately. */
export const EXPLORE_MAX_DEFAULT = 3;

function usage(explore) {
  console.error(
    `usage: node follow.mjs (--follow-back|--follow-likers${explore ? '|--follow-explore' : ''}) ` +
    '[--dry-run] [--max N] [--delay-min S] [--delay-max S] [--posts N]' +
    (explore
      ? '\n       explore only: [--seed <account> …] [--seed-side following|followers] ' +
        '[--min-followers N] [--max-followers N]'
      : ''),
  );
}

/** Parse the shared auto-follow flags out of process.argv (full argv — this slices the first
 *  two itself). `defaults` lets a high-risk channel lower its own cap and lengthen its delay,
 *  and `defaults.explore` opts the channel into the explore mode.
 *
 *  A channel that has not implemented explore must REJECT `--follow-explore` rather than ignore
 *  it: most channel main()s are shaped `if (mode === 'follow-back') … else …likers`, so an
 *  unrecognised mode would silently run the liker path. Refusing here makes the failure of a
 *  forgotten opt-in "clear refusal", not "different action". */
export function parseFollowArgs(argv, defaults = {}) {
  const a = argv.slice(2);
  const supportsExplore = defaults.explore === true;
  const wants = [
    ['follow-back', a.includes('--follow-back')],
    ['follow-likers', a.includes('--follow-likers')],
    ['explore', a.includes('--follow-explore')],
  ].filter(([, on]) => on).map(([m]) => m);
  if (wants.length === 1 && wants[0] === 'explore' && !supportsExplore) {
    console.error('this channel does not implement --follow-explore (no way to read an arbitrary account\'s follower/following list).');
    process.exit(1);
  }
  if (wants.length !== 1) { // neither or several given — exactly one is required
    usage(supportsExplore);
    process.exit(1);
  }
  const mode = wants[0];
  const dryRun = a.includes('--dry-run');
  const numFlag = (flag, def) => {
    const i = a.indexOf(flag);
    if (i < 0) return def;
    const v = Number(a[i + 1]);
    return Number.isFinite(v) ? v : def;
  };
  const strFlags = (flag) => {
    const out = [];
    for (let i = 0; i < a.length; i++) if (a[i] === flag && a[i + 1] && !a[i + 1].startsWith('--')) out.push(a[i + 1]);
    return out;
  };
  const delayMin = numFlag('--delay-min', defaults.delayMin ?? 30);
  const maxDefault = mode === 'explore'
    ? Math.min(defaults.max ?? EXPLORE_MAX_DEFAULT, EXPLORE_MAX_DEFAULT)
    : (defaults.max ?? 15);
  return {
    mode,
    dryRun,
    max: numFlag('--max', maxDefault),
    delayMin,
    // Clamp: passing only `--delay-min` on a channel whose default max is lower would invert the
    // range, and an inverted range collapses the wait to zero — the opposite of what was asked.
    delayMax: Math.max(delayMin, numFlag('--delay-max', defaults.delayMax ?? 90)),
    posts: numFlag('--posts', defaults.posts ?? 10),
    // explore only
    seeds: strFlags('--seed'),
    seedSide: strFlags('--seed-side')[0] || null,
    minFollowers: numFlag('--min-followers', 30),
    maxFollowers: numFlag('--max-followers', 50000),
  };
}

/** Print the terms-of-service warning before a real run on a channel that polices automation.
 *  Channels call this themselves so the text can name what that platform actually does. */
export function warnRealRun(channel, note) {
  console.error(
    `\n  !! ${channel}: this is a REAL run — follows will be issued from your account.\n` +
    `     ${note}\n` +
    '     Re-run with --dry-run to preview instead.\n',
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Safety runner shared by every channel's follow.mjs.
 * - Dedups candidates against the ledger (followedIds) and within the batch.
 * - Caps at `max`, logging (never silently truncating) what was skipped or capped.
 * - dry-run: prints each candidate via describe(c) and writes NOTHING to the ledger (never
 *   calls follow(), never calls recordFollow()) — a preview must not suppress a real follow
 *   attempted later, so it cannot leave a trace that followedIds() would read.
 * - real: awaits follow(c.targetId) per candidate; records 'followed' on success, 'failed'
 *   (and continues) on error; sleeps a random delay in [delayMin, delayMax] seconds BETWEEN
 *   real follows (not after the last one).
 * - A follow() error with `.fatal === true` (rate limited / auth / credit exhausted — see each
 *   channel's classify()) stops the rest of the batch instead of grinding through candidates
 *   that would fail the same way.
 */
export async function runFollows({ channel, candidates, via, dryRun, max, delayMin, delayMax, follow, describe }) {
  const already = followedIds(channel);
  const seenInBatch = new Set();
  const deduped = [];
  let skippedDedup = 0;
  for (const c of candidates) {
    const id = String(c.targetId);
    if (already.has(id) || seenInBatch.has(id)) { skippedDedup++; continue; }
    seenInBatch.add(id);
    deduped.push(c);
  }
  const capped = Math.max(0, deduped.length - max);
  const batch = deduped.slice(0, max);

  console.log(
    `via=${via} candidates=${candidates.length} after-dedup=${deduped.length} ` +
    `skipped(dedup)=${skippedDedup} capped=${capped} batch=${batch.length} dry=${dryRun}`,
  );
  // The cap is bounded coverage, and a number inside a one-line summary reads as "handled".
  // Explore in particular routinely discards hundreds of candidates per run, and a reader who
  // does not notice will think the pool is exhausted when it has barely been touched.
  if (capped > 0) {
    console.error(`  !! ${capped} candidate(s) left untouched by --max ${max} — this run covered ${batch.length} of ${deduped.length}.`);
  }

  let followed = 0;
  let stopped = false;
  for (let i = 0; i < batch.length; i++) {
    const c = batch[i];
    if (dryRun) {
      console.log(`  [dry] ${describe(c)}`); // preview only — no recordFollow, no ledger write
      continue;
    }
    try {
      await follow(c.targetId);
      console.log(`  [ok] ${describe(c)}`);
      recordFollow(channel, { targetId: c.targetId, handle: c.handle, via, srcPost: c.srcPost, status: 'followed' });
      followed++;
    } catch (e) {
      // `.unconfirmed` (set by a channel's follow() when the write itself succeeded but an
      // authoritative re-query did not show the relationship) is distinct from a plain failure
      // (an error before or during the write). Both skip `status: 'followed'` — so a
      // real-but-unverified follow is never deduped away as done, and never silently retried
      // as if nothing had happened either. `[unconfirmed]` means "check by hand", not "retry".
      // `.blocked` (a definitive platform refusal — see blockedIds) records 'blocked' so the
      // channel can drop the target from future candidate lists. Like 'unconfirmed' it is
      // deliberately NOT 'followed': the relationship does not exist.
      const tag = e.blocked ? 'blocked' : e.unconfirmed ? 'unconfirmed' : 'fail';
      const status = e.blocked ? 'blocked' : e.unconfirmed ? 'unconfirmed' : 'failed';
      console.error(`  [${tag}] ${describe(c)}: ${e.message}`);
      recordFollow(channel, { targetId: c.targetId, handle: c.handle, via, srcPost: c.srcPost, status });
      if (e.fatal) {
        console.error('  ↳ batch stopped (rate limit / credit / auth signal detected).');
        stopped = true;
        break;
      }
    }
    if (i < batch.length - 1) {
      const ms = Math.round((delayMin + Math.random() * (delayMax - delayMin)) * 1000);
      await sleep(ms);
    }
  }

  console.log(
    `via=${via} candidates=${candidates.length} followed=${followed} skipped(dedup)=${skippedDedup} ` +
    `capped=${capped} dry=${dryRun}${stopped ? ' stopped=true' : ''}`,
  );
  return { followed, skippedDedup, capped, stopped };
}
