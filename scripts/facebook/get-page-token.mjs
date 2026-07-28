#!/usr/bin/env node
// One-time setup: exchange a short-lived USER access token (generated in the
// Graph API Explorer) into a long-lived PAGE access token for a Facebook Page,
// then persist it to $CROSSPOST_HOME/.env as FACEBOOK_PAGE_ACCESS_TOKEN. Page
// tokens derived from a long-lived user token do not expire (until password
// change / revoke).
//
//   node get-page-token.mjs --user-token <SHORT_LIVED_USER_TOKEN>
//
// The user token must be generated in developers.facebook.com/tools/explorer
// with your Meta app (FACEBOOK_APP_ID) and permissions:
//   pages_show_list, pages_manage_posts, pages_read_engagement
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { home } from '../lib/env.mjs';

const ENV = path.join(home(), '.env');
const GRAPH = 'https://graph.facebook.com/v21.0';

if (!existsSync(ENV)) {
  console.error(`missing ${ENV} — copy config/.env.example there first, then fill in FACEBOOK_APP_ID / FACEBOOK_APP_SECRET / FACEBOOK_PAGE_ID`);
  process.exit(1);
}
let _env = readFileSync(ENV, 'utf8');
const env = (k) => (_env.match(new RegExp(`^${k}="?([^"\\n]+)`, 'm')) || [])[1];
function setEnv(key, val) {
  const line = `${key}="${val}"`;
  if (new RegExp(`^${key}=`, 'm').test(_env)) {
    _env = _env.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  } else {
    _env = _env.replace(/\n?$/, `\n${line}\n`);
  }
}

const args = process.argv.slice(2);
const uti = args.indexOf('--user-token');
const userToken =
  (uti !== -1 ? args[uti + 1] : null) ||
  process.env.FACEBOOK_USER_TOKEN ||
  env('FACEBOOK_USER_TOKEN');
if (!userToken || userToken.startsWith('--')) {
  console.error(
    'need --user-token <token> from Graph API Explorer\n' +
      '(perms: pages_show_list,pages_manage_posts,pages_read_engagement)',
  );
  process.exit(1);
}

const appId = env('FACEBOOK_APP_ID');
const appSecret = env('FACEBOOK_APP_SECRET') || env('THREADS_APP_SECRET');
const pageId = env('FACEBOOK_PAGE_ID');
if (!appId) { console.error('missing FACEBOOK_APP_ID in .env'); process.exit(1); }
if (!appSecret) { console.error('missing app secret (FACEBOOK_APP_SECRET or THREADS_APP_SECRET) in .env'); process.exit(1); }
if (!pageId) { console.error('missing FACEBOOK_PAGE_ID in .env'); process.exit(1); }

const j = async (url) => {
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error(JSON.stringify(d.error));
  return d;
};

// 1) short-lived user token -> long-lived user token
const ll = await j(
  `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token` +
    `&client_id=${appId}&client_secret=${appSecret}` +
    `&fb_exchange_token=${encodeURIComponent(userToken)}`,
);
console.log('long-lived user token acquired (expires_in:', ll.expires_in ?? 'n/a', ')');

// 2) list managed pages -> find our page -> permanent page token
// /me/accounts는 페이지네이션되는 edge다 — 첫 페이지만 보면 관리 중인 Page를
// "관리하지 않는다"고 잘못 보고하고 셋업이 막힌다. 커서를 끝까지 따라간다.
const pages = [];
let next = `${GRAPH}/me/accounts?limit=100&access_token=${encodeURIComponent(ll.access_token)}`;
while (next) {
  const chunk = await j(next);
  pages.push(...(chunk.data || []));
  next = chunk.paging?.next || null;
}
const page = pages.find((p) => String(p.id) === String(pageId));
if (!page) {
  console.error(
    'page', pageId, 'not in /me/accounts. managed pages:',
    pages.map((p) => `${p.name}:${p.id}`).join(', ') || '(none)',
  );
  process.exit(2);
}

setEnv('FACEBOOK_APP_ID', appId);
setEnv('FACEBOOK_PAGE_ID', pageId);
setEnv('FACEBOOK_PAGE_ACCESS_TOKEN', page.access_token);
writeFileSync(ENV, _env);
console.log('OK page:', page.name, `(${page.id})`);
console.log(
  'FACEBOOK_PAGE_ACCESS_TOKEN persisted to .env (',
  page.access_token.slice(0, 6), '… len', page.access_token.length, ')',
);
