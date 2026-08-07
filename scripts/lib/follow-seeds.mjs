// Seed accounts for the `explore` follow mode — where the candidate pool comes from.
//
// A seed is somebody else's account in your field. Explore walks its adjacency graph (the people
// it follows — `--seed-side following`, the default — or the people who follow it, `followers`)
// and proposes accounts you have no connection to yet.
//
// **There are no seeds shipped with this plugin, and that is deliberate.** Whose neighbourhood
// is worth mining is entirely a function of your topic, so a default list would be somebody
// else's audience. Configure your own:
//
//   $CROSSPOST_HOME/follow-seeds.json
//   {
//     "x":         ["simonw", "swyx"],
//     "brunch":    [{ "id": "ggL", "note": "AI × marketing, follows a lot of people in the field" }],
//     "instagram": ["someone"],
//     "threads":   ["someone"],
//     "facebook":  ["some.page", "100064561576986"]
//   }
//
// An entry is a handle string, or `{id, note}` when you want to record why it is on the list.
// The id format is per channel: X = handle without `@`, Brunch = the userId after `@@` (not the
// profileId), Instagram/Threads = username, Facebook = the URL slug or the numeric id.
// `--seed <account>` (repeatable) overrides the file for one run.
//
// Choosing seeds — two things that are easy to get wrong:
//   · `following` beats `followers` as a source. A big account's followers can be anyone, and in
//     practice many are empty or bot accounts; the accounts it *follows* are a list it curated.
//     `followers` is still useful for small, niche seeds — hence the flag.
//   · Size is not the criterion, reach into your topic is. An account with 200k followers that
//     follows eleven people is useless as a seed, and on some platforms the most prominent
//     accounts subscribe to nobody at all. Check the side you intend to read before adding it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { home } from './env.mjs';

export const SEEDS_FILE = 'follow-seeds.json';

/** Per-channel `--seed-side` default. The global default is `following`, but some platforms only
 *  expose one side: a Threads profile shows a follower count and no following list at all, so
 *  defaulting it to `following` would make every run need the flag — and forgetting the flag
 *  stops the run rather than reading the other side. */
export const SEED_SIDE_DEFAULT = {
  threads: 'followers',
  // A Facebook page tends to follow almost nobody, so its `following` list is a handful of rows.
  facebook: 'followers',
};

export function seedSideFor(channel, override) {
  return override || SEED_SIDE_DEFAULT[channel] || 'following';
}

function loadFile() {
  const p = join(home(), SEEDS_FILE);
  let text;
  try {
    text = readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    // Fail loudly. Read as empty, this would look exactly like "no seeds configured", and the
    // fix printed for that ("create the file") is the wrong instruction for a file that exists.
    throw new Error(`${p} is not valid JSON — fix it (or delete it) and retry.\n  ${e.message}`);
  }
}

const normalize = (e) => (typeof e === 'string' ? { id: e, note: '' } : { id: e?.id, note: e?.note || '' });

/**
 * Seeds for a channel. A CLI `--seed` (one or more) replaces the configured list entirely.
 * Throws when there is nothing to explore from — returning an empty list would print
 * "candidates=0", which reads as "nobody new to follow" rather than "you configured nothing".
 */
export function seedsFor(channel, override = []) {
  if (override.length) return override.map((id) => ({ id, note: 'from --seed' }));
  const list = (loadFile()[channel] || []).map(normalize).filter((s) => s.id);
  if (!list.length) {
    throw new Error(
      `${channel}: no explore seeds configured.\n` +
      `  Add them to ${join(home(), SEEDS_FILE)}:\n` +
      `    { "${channel}": ["some-account", "another-account"] }\n` +
      '  or pass them for this run: --seed some-account --seed another-account\n' +
      '  A seed is an account in your field whose neighbourhood is worth mining — see the header ' +
      'of scripts/lib/follow-seeds.mjs for how to pick one.',
    );
  }
  return list;
}

/**
 * Round-robin the per-seed candidate lists into one list.
 *
 * Concatenating instead would mean `--max 3` always cuts inside the first seed, so every other
 * seed contributes nothing on every run no matter how many times it is called.
 */
export function interleaveBySeed(bySeed) {
  const lists = [...bySeed.values()].filter((l) => l.length);
  const out = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) if (i < l.length) out.push(l[i]);
  }
  return out;
}
