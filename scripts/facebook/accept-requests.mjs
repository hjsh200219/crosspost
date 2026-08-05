#!/usr/bin/env node
// Facebook friend-request auto-accept, for your personal profile (`FACEBOOK_PROFILE`).
//
// **Deliberately separate from follow.mjs and follow-core.mjs.** Accepting a friend request
// creates a **symmetric relationship that both sides consented to**, which is a different thing
// from the asymmetric follow the rest of the follow tooling does — the two are never mixed into
// one mode or flag. It also does not fit follow-core's "exactly one of --follow-back /
// --follow-likers" contract, so rather than force it in, this file keeps its own minimal safety
// runner: ledger, cap, delay, dry-run.
//
// ⚠️ Meta polices automation hard, and this acts on your personal profile. Defaults are
// conservative (`--max 3`, 90–300s between accepts) and a non-dry run prints a warning.
// Preview with `--dry-run` first.
//
// Discovery — `facebook.com/friends/requests` lists the pending requests. Each row has confirm
// and delete buttons plus a `profile.php?id=<fbid>` link for the requester, which is where
// `{id, name}` comes from. Three measured traps:
//   1) **Always open a fresh tab.** Reusing a tab that has the notification dropdown open mixes
//      notification text into the scrape (a notification headline gets picked up as a name).
//   2) `a[href*="profile.php?id="]` also matches the mutual-friend mini avatars in each row —
//      those have no text, so entries with an empty `textContent` are dropped.
//   3) **The list is virtualized**: only the rows in the viewport exist in the DOM, so a header
//      saying 15 can coexist with 7 recovered rows. That is not truncated silently — the run
//      warns, and reports what it actually recovered.
//
// The accept itself clicks the row's real confirm button in-page: the underlying mutation body
// carries per-page-load signed anti-abuse tokens (`fb_dtsg`, `lsd`, `__csr`, …) that cannot be
// reassembled by hand. Confirmation re-opens the list in a **brand new tab** — the state of the
// document you just clicked in is optimistic client render, not evidence.
//
// usage: node accept-requests.mjs [--dry-run] [--max N] [--delay-min S] [--delay-max S]
// Requires a logged-in Facebook session in the shared CDP browser.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { loadEnv, dataPath, cdpPort } from '../lib/env.mjs';
import { warnRealRun } from '../lib/follow-core.mjs';

loadEnv();

const LEDGER_PATH = dataPath('ledgers/accepted-facebook.json');
const PORT = cdpPort();
const REQUESTS_URL = 'https://www.facebook.com/friends/requests';
// DOM matchers, not user-facing copy — the labels Facebook renders in the session's interface
// language. Translating them breaks the click; override them instead.
const LABEL_CONFIRM = process.env.FACEBOOK_CONFIRM_LABEL || '확인';
// The heading is only used to notice under-recovery, so it matches both locales by default.
const HEADING_PATTERN = process.env.FACEBOOK_FRIEND_REQUESTS_HEADING
  || '^(?:친구 요청\\s*(\\d+)개|Friend requests?(?:\\s*\\((\\d+)\\))?)$';

function usage() {
  console.error('usage: node accept-requests.mjs [--dry-run] [--max N] [--delay-min S] [--delay-max S]');
}

function parseArgs(argv) {
  const a = argv.slice(2);
  const numFlag = (flag, def) => {
    const i = a.indexOf(flag);
    if (i < 0) return def;
    const v = Number(a[i + 1]);
    return Number.isFinite(v) ? v : def;
  };
  const delayMin = numFlag('--delay-min', 90);
  return {
    dryRun: a.includes('--dry-run'),
    max: numFlag('--max', 3),
    delayMin,
    // Clamp, for the same reason follow-core does: a lone --delay-min above the default max
    // would invert the range and collapse the wait to zero.
    delayMax: Math.max(delayMin, numFlag('--delay-max', 300)),
  };
}

function loadLedger() {
  try { return JSON.parse(readFileSync(LEDGER_PATH, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return [];
    // Fail closed, same stance as follow-core: reading a corrupt ledger as empty would re-accept
    // requests already handled.
    console.error(`accept-requests: ${LEDGER_PATH} exists but is not valid JSON — refusing to treat it as empty.\n  ${e.message}`);
    process.exit(1);
  }
}

const acceptedIds = () => new Set(loadLedger().filter((e) => e.status === 'accepted').map((e) => String(e.id)));

function recordAttempt(entry) {
  const ledger = loadLedger();
  ledger.push({ id: entry.id, name: entry.name, status: entry.status, ts: new Date().toISOString() });
  mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`);
}

async function listPendingRequests(ctx) {
  const page = await ctx.newPage(); // always a fresh tab — see trap 1 in the header
  try {
    await page.goto(REQUESTS_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2000);
    const found = await page.evaluate((headingSrc) => {
      const re = new RegExp(headingSrc);
      const heading = [...document.querySelectorAll('div,span,h1,h2')]
        .find((e) => re.test((e.textContent || '').trim()));
      if (!heading) return { total: null, rows: [] };
      const m = (heading.textContent || '').trim().match(re);
      const total = m ? Number(m[1] ?? m[2]) : null;
      const container = heading.parentElement;
      const rows = [...container.querySelectorAll('a[href*="profile.php?id="]')]
        .map((a) => {
          const idM = a.getAttribute('href').match(/id=(\d+)/);
          const name = (a.textContent || '').trim();
          return idM && name && name.length < 40 ? { id: idM[1], name } : null;
        })
        .filter(Boolean);
      return { total: Number.isFinite(total) ? total : null, rows };
    }, HEADING_PATTERN);

    const byId = new Map();
    for (const r of found.rows) if (!byId.has(r.id)) byId.set(r.id, r);
    const out = [...byId.values()];
    if (found.total != null && out.length < found.total) {
      console.error(`  ↳ warning: the list is virtualized — the header says ${found.total} but only ${out.length} row(s) rendered. Nothing is truncated; only what was recovered is reported.`);
    }
    return out;
  } finally {
    await page.close().catch(() => {});
  }
}

async function acceptRequest(ctx, { id, name }) {
  const page = await ctx.newPage();
  try {
    await page.goto(REQUESTS_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2000);
    const clicked = await page.evaluate(({ targetId, label }) => {
      const link = document.querySelector(`a[href*="profile.php?id=${targetId}"]`);
      if (!link) return false;
      const row = link.closest('div')?.parentElement;
      const btn = row ? [...row.querySelectorAll('div[role=button],button')].find((b) => (b.textContent || '').trim() === label) : null;
      if (!btn) return false;
      btn.click();
      return true;
    }, { targetId: id, label: LABEL_CONFIRM });
    if (!clicked) throw new Error(`${name}(${id}): no confirm button (already handled, layout change, or outside the virtualized viewport)`);
    await page.waitForTimeout(2500);
  } finally {
    await page.close().catch(() => {});
  }

  const confirmPage = await ctx.newPage();
  let stillPending = null; // null = the re-read itself failed, which is not the same as true/false
  try {
    await confirmPage.goto(REQUESTS_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await confirmPage.waitForTimeout(2000);
    stillPending = await confirmPage.evaluate((targetId) => !!document.querySelector(`a[href*="profile.php?id=${targetId}"]`), id);
  } catch { /* stillPending stays null */ }
  finally {
    await confirmPage.close().catch(() => {});
  }
  if (stillPending === null) {
    const err = new Error(`${name}(${id}): the re-read failed, so the outcome is unknown`);
    err.unconfirmed = true;
    throw err;
  }
  // Still listed after a fresh re-read is closer to "it did not work" than to "unknown", so it
  // is a plain failure rather than `unconfirmed`.
  if (stillPending) throw new Error(`${name}(${id}): still pending after a fresh re-read of the list`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const known = ['--dry-run', '--max', '--delay-min', '--delay-max'];
  const argv = process.argv.slice(2);
  if (argv.some((a, i) => a.startsWith('--') && !known.includes(a) && !(i > 0 && known.includes(argv[i - 1])))) {
    usage();
    process.exit(1);
  }
  const { dryRun, max, delayMin, delayMax } = parseArgs(process.argv);

  if (!dryRun) {
    warnRealRun(
      'facebook friend requests',
      'Accepting a friend request creates a mutual connection on your personal profile — review the preview before running this for real.',
    );
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { noDefaults: true });
  try {
    const ctx = browser.contexts()[0];

    const pending = await listPendingRequests(ctx);
    console.error(`  ↳ pending friend requests=${pending.length}`);

    const already = acceptedIds();
    const candidates = pending.filter((p) => !already.has(p.id));
    const capped = Math.max(0, candidates.length - max);
    const batch = candidates.slice(0, max);
    console.log(`candidates=${pending.length} after-dedup=${candidates.length} capped=${capped} batch=${batch.length} dry=${dryRun}`);

    if (dryRun) {
      batch.forEach((c) => console.log(`  [dry] ${c.name} (${c.id})`));
      console.log(`candidates=${pending.length} accepted=0 capped=${capped} dry=${dryRun}`);
      return;
    }

    let accepted = 0;
    for (let i = 0; i < batch.length; i++) {
      const c = batch[i];
      try {
        await acceptRequest(ctx, c);
        console.log(`  [ok] ${c.name} (${c.id})`);
        recordAttempt({ id: c.id, name: c.name, status: 'accepted' });
        accepted++;
      } catch (e) {
        // Same contract as follow-core: `unconfirmed` means the outcome is unknown, so it is
        // recorded as neither accepted nor failed. Only `accepted` suppresses a later attempt.
        const tag = e.unconfirmed ? 'unconfirmed' : 'fail';
        console.error(`  [${tag}] ${c.name} (${c.id}): ${e.message}`);
        recordAttempt({ id: c.id, name: c.name, status: e.unconfirmed ? 'unconfirmed' : 'failed' });
        if (e.fatal) { console.error('  ↳ batch stopped (rate limit / auth signal detected).'); break; }
      }
      if (i < batch.length - 1) await sleep(Math.round((delayMin + Math.random() * (delayMax - delayMin)) * 1000));
    }
    console.log(`candidates=${pending.length} accepted=${accepted} capped=${capped} dry=${dryRun}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
