#!/usr/bin/env node
// Shared multi-account resolution for the LinkedIn scripts.
//
// Default account → '' suffix, fully back-compat with a single-account .env
// (LINKEDIN_ACCESS_TOKEN / _PERSON_URN / _TOKEN_EXPIRES / _REFRESH_TOKEN, published-linkedin.json).
// A named account 'hj' reads LINKEDIN_ACCESS_TOKEN_HJ, ledger published-linkedin-hj.json, etc.
//
// Account is chosen by priority: --account/-a flag > LINKEDIN_ACCOUNT env > 'default'.
//
// App creds (CLIENT_ID/SECRET) fall back to the shared (unsuffixed) value — one LinkedIn
// app can publish on behalf of many members who each authorized it. TOKENS never fall back:
// a missing per-account token must error, not silently post to the default profile.
//
// Adding a person = add env keys (+ optionally LINKEDIN_VANITY_<NAME>, LINKEDIN_CDP_PORT_<NAME>),
// run `node auth.mjs --account <name>`, done. No code edits.
import { loadEnv as loadCrosspostEnv, dataPath, cdpPort as sharedCdpPort } from '../lib/env.mjs';

loadCrosspostEnv(); // merges $CROSSPOST_HOME/.env into process.env

export function parseAccount(argv) {
  let account = process.env.LINKEDIN_ACCOUNT || 'default';
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--account' || a === '-a') { account = argv[++i] || account; continue; }
    if (a.startsWith('--account=')) { account = a.slice('--account='.length); continue; }
    rest.push(a);
  }
  return { account, rest };
}

// '' for the default profile (back-compat), else _UPPERCASE (LINKEDIN_ACCESS_TOKEN_HJ).
export function suffix(account) {
  if (!account || account === 'default') return '';
  return '_' + account.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

export function loadEnv(account) {
  const sfx = suffix(account);
  const raw = (k) => process.env[k + sfx];
  return {
    sfx,
    pick: (k) => raw(k),                 // strict — tokens, no cross-account fallback
    pickShared: (k) => raw(k) ?? process.env[k], // app creds — suffixed first, shared fallback
  };
}

// published-linkedin.json → published-linkedin-hj.json ; stats-history-linkedin.jsonl →
// stats-history-linkedin-hj.jsonl (default keeps the base name). Files live under the
// shared crosspost data home (see lib/env.mjs), not the plugin install directory.
export function accountFile(base, account) {
  const sfx = suffix(account);
  let named = base;
  if (sfx) {
    const slug = sfx.slice(1).toLowerCase();
    const dot = base.lastIndexOf('.');
    named = dot < 0 ? `${base}-${slug}` : `${base.slice(0, dot)}-${slug}${base.slice(dot)}`;
  }
  return dataPath(`ledgers/${named}`);
}

// CDP port for this account's logged-in Chromium (stats/publish browser path).
export function cdpPort(account) {
  const { pickShared } = loadEnv(account);
  return process.env.LI_CDP_PORT || pickShared('LINKEDIN_CDP_PORT') || sharedCdpPort();
}

// Profile vanity slug for stats --all discovery (linkedin.com/in/<vanity>).
// No default — callers that need it must fail clearly when it's unset (LINKEDIN_VANITY).
export function vanity(account) {
  const { pickShared } = loadEnv(account);
  return pickShared('LINKEDIN_VANITY') || null;
}

// Human label for log lines.
export function label(account) {
  return (!account || account === 'default') ? 'default' : account;
}
