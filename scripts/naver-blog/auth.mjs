#!/usr/bin/env node
// Naver OAuth2 (authorization code) one-time login → access/refresh tokens.
// Opens the consent screen in your DEFAULT browser (log in + 동의 there), captures
// the code on a local callback server, exchanges it, and writes tokens to
// $CROSSPOST_HOME/.env (NAVER_BLOG_ACCESS_TOKEN / _REFRESH_TOKEN / _TOKEN_EXPIRES).
//
// Prereq: NAVER_BLOG_CLIENT_ID / _SECRET / _REDIRECT_URI in .env, and the redirect
// URI (http://localhost:8787/callback) registered in the Naver Developers app.
//
//   node auth.mjs
import { createServer } from 'http';
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import { env, upsertEnv } from './token.mjs';

const CLIENT_ID = env('NAVER_BLOG_CLIENT_ID');
const CLIENT_SECRET = env('NAVER_BLOG_CLIENT_SECRET');
const REDIRECT = env('NAVER_BLOG_REDIRECT_URI');
if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT) {
  console.error('NAVER_BLOG_CLIENT_ID / _SECRET / _REDIRECT_URI missing in $CROSSPOST_HOME/.env');
  process.exit(1);
}
const PORT = Number(new URL(REDIRECT).port) || 8787;
const AUTHORIZE_URL = 'https://nid.naver.com/oauth2.0/authorize';
const TOKEN_URL = 'https://nid.naver.com/oauth2.0/token';

const state = randomBytes(16).toString('hex');
const authorizeUrl = `${AUTHORIZE_URL}?` + new URLSearchParams({
  response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT, state,
}).toString();

const codePromise = new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
    const code = u.searchParams.get('code');
    const recvState = u.searchParams.get('state');
    const err = u.searchParams.get('error_description') || u.searchParams.get('error')
      || (code && recvState !== state ? 'state mismatch (CSRF protection)' : null);
    const ok = code && !err;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<h2>${ok ? '네이버 인증 완료. 창을 닫아도 됩니다.' : 'OAuth 실패: ' + err}</h2>`);
    server.close();
    ok ? resolve(code) : reject(new Error('oauth: ' + err));
  });
  server.listen(PORT, () => console.log('callback server on', REDIRECT));
});

console.log('\nLog into Naver and approve in the browser. If it did not open, open this URL manually:\n' + authorizeUrl + '\n');
try { execSync(`open ${JSON.stringify(authorizeUrl)}`); } catch {}

const code = await codePromise;

const qs = new URLSearchParams({
  grant_type: 'authorization_code', client_id: CLIENT_ID,
  client_secret: CLIENT_SECRET, code, state,
});
const res = await fetch(`${TOKEN_URL}?${qs}`);
const tok = await res.json().catch(() => ({}));
if (!res.ok || tok.error || !tok.access_token)
  throw new Error(`token exchange failed (${tok.error || res.status}: ${tok.error_description || ''})`);

upsertEnv('NAVER_BLOG_ACCESS_TOKEN', tok.access_token);
upsertEnv('NAVER_BLOG_TOKEN_EXPIRES', String(Math.floor(Date.now() / 1000) + Number(tok.expires_in || 0)));
if (tok.refresh_token) upsertEnv('NAVER_BLOG_REFRESH_TOKEN', tok.refresh_token);
console.log('Naver login OK, token saved' + (tok.refresh_token ? '' : ' (no refresh_token issued)'));
