#!/usr/bin/env node
// X (Twitter) stats — official API v2 GET /2/tweets (read), OAuth 1.0a (HMAC-SHA1) manual signing.
// Metrics: views (public_metrics.impression_count), likes, reposts, replies. No browser needed.
// Targets are the rootId values from the published-x.json ledger. Fetched in batches of 100 ids.
// Output is a table (newest first, with a totals row).
// Credentials: X_API_KEY/X_API_SECRET/X_ACCESS_TOKEN/X_ACCESS_SECRET (shared with post-api.mjs).
// Usage: node stats.mjs [--limit N]  (default: latest 10, --limit 0 = all)

import { readFileSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { loadEnv, dataPath } from '../lib/env.mjs';

loadEnv();
const LEDGER = dataPath('ledgers/published-x.json');
const API = 'https://api.x.com/2/tweets';
const BATCH = 100; // GET /2/tweets ids cap

const CK = process.env.X_API_KEY;
const CS = process.env.X_API_SECRET;
const AT = process.env.X_ACCESS_TOKEN;
const AS = process.env.X_ACCESS_SECRET;

// --- OAuth 1.0a (RFC3986 percent-encode, HMAC-SHA1) ---
// Unlike post-api.mjs's authHeader, GET must include the query params in the signature base too.
const enc = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function authHeader(method, url, params = {}) {
  const oauth = {
    oauth_consumer_key: CK,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: AT,
    oauth_version: '1.0',
  };
  const all = { ...oauth, ...params };
  const paramStr = Object.keys(all).sort().map((k) => `${enc(k)}=${enc(all[k])}`).join('&');
  const base = [method.toUpperCase(), enc(url), enc(paramStr)].join('&');
  const signingKey = `${enc(CS)}&${enc(AS)}`;
  oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(base).digest('base64');
  return 'OAuth ' + Object.keys(oauth).sort().map((k) => `${enc(k)}="${enc(oauth[k])}"`).join(', ');
}

function parseArgs() {
  const a = process.argv.slice(2);
  let limit = 10;
  const i = a.indexOf('--limit');
  if (i >= 0) limit = Number(a[i + 1]);
  return { limit };
}

// UTC ISO → local YYYY-MM-DD, timezone configurable via TIMEZONE or TZ env (defaults to the
// system's local timezone). A plain UTC slice would push posts published in the early-morning
// hours of the target timezone onto the previous day.
const ZONE = process.env.TIMEZONE || process.env.TZ || undefined;
let dateFmt;
try {
  dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
} catch {
  console.error(`↳ Invalid TIMEZONE/TZ "${ZONE}" — falling back to system local timezone.`);
  dateFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
function formatDate(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? dateFmt.format(new Date(t)) : '';
}

// X's ledger rows always carry a full ISO `ts`, so sorting on it directly is sufficient (no
// cross-channel ledger to borrow a timestamp from, unlike channels that only store a bare date).
function sortMs(row) {
  const t = Date.parse(row.ts || '');
  return Number.isFinite(t) ? t : 0;
}

async function fetchBatch(ids) {
  const params = { ids: ids.join(','), 'tweet.fields': 'public_metrics,created_at,text' };
  const qs = Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join('&');
  const res = await fetch(`${API}?${qs}`, { headers: { Authorization: authHeader('GET', API, params) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body?.detail || body?.title || JSON.stringify(body).slice(0, 200);
    const hint = res.status === 429 ? ' (rate limit — retry after a delay)'
      : res.status === 402 ? ' (credits depleted)'
        : res.status === 401 || res.status === 403 ? ' (auth failed — check your .env credentials)' : '';
    throw new Error(`HTTP ${res.status}${hint}: ${detail}`);
  }
  return body;
}

async function main() {
  const { limit } = parseArgs();
  if (!CK || !CS || !AT || !AS) throw new Error('Missing X_API_KEY/X_API_SECRET/X_ACCESS_TOKEN/X_ACCESS_SECRET (check your .env)');

  let ledger;
  try { ledger = JSON.parse(readFileSync(LEDGER, 'utf8')); } catch { ledger = []; }
  ledger = ledger.filter((e) => e.rootId && !e.dup); // skip duplicates/unpublished rows
  if (!ledger.length) { console.log('No X posts yet (published-x.json is empty)'); return; }
  ledger.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  const targets = limit > 0 ? ledger.slice(0, limit) : ledger;

  // Batch-fetch 100 ids at a time → id -> metrics map
  const byId = new Map();
  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH).map((e) => e.rootId);
    const body = await fetchBatch(chunk);
    for (const d of body.data || []) byId.set(d.id, d);
    // errors[]: deleted posts / stale ledger ids (err.value holds the id)
    for (const err of body.errors || []) {
      if (err.value) byId.set(String(err.value), { missing: err.detail || err.title || 'fetch failed' });
    }
  }

  const rows = targets.map((e) => {
    const d = byId.get(e.rootId);
    if (!d || d.missing) {
      return { id: e.rootId, text: '(fetch failed)', date: formatDate(e.ts), ts: e.ts, views: 0, likes: 0, reposts: 0, replies: 0 };
    }
    const m = d.public_metrics || {};
    return {
      id: e.rootId,
      text: (d.text || '').slice(0, 40).replace(/\n/g, ' ') || '(untitled)',
      date: formatDate(d.created_at || e.ts),
      ts: e.ts,
      views: m.impression_count || 0,
      likes: m.like_count || 0,
      reposts: m.retweet_count || 0,
      replies: m.reply_count || 0,
    };
  });

  rows.sort((a, b) => sortMs(b) - sortMs(a));
  const sum = rows.reduce((a, r) => ({ views: a.views + r.views, likes: a.likes + r.likes, reposts: a.reposts + r.reposts, replies: a.replies + r.replies }), { views: 0, likes: 0, reposts: 0, replies: 0 });
  console.log('| Title | Date | Views | Likes | Reposts | Replies |');
  console.log('| --- | --- | --: | --: | --: | --: |');
  for (const r of rows) console.log(`| ${r.text} | ${r.date} | ${r.views} | ${r.likes} | ${r.reposts} | ${r.replies} |`);
  console.log(`| **Total (${rows.length})** | | **${sum.views}** | **${sum.likes}** | **${sum.reposts}** | **${sum.replies}** |`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
