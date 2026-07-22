#!/usr/bin/env node
// LinkedIn OAuth 2.0 (authorization code) → access token for w_member_social.
// Opens the consent screen in your DEFAULT browser (log in as the correct account
// there), captures the code on a local callback server, exchanges it, fetches the
// person URN, and writes tokens into $CROSSPOST_HOME/.env
// (LINKEDIN_ACCESS_TOKEN / _PERSON_URN / _TOKEN_EXPIRES / _REFRESH_TOKEN).
//
// Prereq: redirect URL  http://localhost:8765/callback  registered in the app's Auth tab.
//
// Multi-account: `node auth.mjs --account hj` writes the tokens with the _HJ suffix
// (LINKEDIN_ACCESS_TOKEN_HJ ...). App creds (CLIENT_ID/SECRET) are shared — one app can
// authorize many members — but a per-account override (LINKEDIN_CLIENT_ID_HJ) wins if set.
import { createServer } from 'http';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { dataPath } from '../lib/env.mjs';
import { parseAccount, loadEnv, suffix, label } from './account.mjs';

const ENV = dataPath('.env');
const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPE = 'openid profile email w_member_social';

const { account } = parseAccount(process.argv.slice(2));
const SFX = suffix(account);
const { pickShared } = loadEnv(account);
const CLIENT_ID = pickShared('LINKEDIN_CLIENT_ID');
const CLIENT_SECRET = pickShared('LINKEDIN_CLIENT_SECRET');
if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('LINKEDIN_CLIENT_ID/SECRET missing in .env');
console.log('account:', label(account), SFX ? `(suffix ${SFX})` : '(default)');

const state = randomUUID();
const authUrl = 'https://www.linkedin.com/oauth/v2/authorization?' + new URLSearchParams({
  response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT,
  scope: SCOPE, state,
}).toString();

function upsertEnv(text, kv) {
  let out = text;
  for (const [k, v] of Object.entries(kv)) {
    const line = `${k}="${v}"`;
    out = new RegExp(`^${k}=.*$`, 'm').test(out)
      ? out.replace(new RegExp(`^${k}=.*$`, 'm'), () => line)
      : out.replace(/\n*$/, '\n') + line + '\n';
  }
  return out;
}

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
    res.end(`<h2>${ok ? 'LinkedIn auth complete. You can close this window.' : 'OAuth failed: ' + err}</h2>`);
    server.close();
    ok ? resolve(code) : reject(new Error('oauth: ' + err));
  });
  server.listen(PORT, () => console.log('callback server on', REDIRECT));
});

// open consent in the user's default browser (they log in as the correct account)
console.log('\nLog in and click Allow in your browser. If it does not open, visit this URL directly:\n' + authUrl + '\n');
try { execSync(`open ${JSON.stringify(authUrl)}`); } catch {}

const code = await codePromise;
console.log('code captured');

// exchange code -> token
const tokRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
  }),
});
const tok = await tokRes.json();
if (!tok.access_token) throw new Error('token exchange failed: ' + JSON.stringify(tok));
console.log('token ok; scope:', tok.scope, '; expires_in:', tok.expires_in);

// person URN via OpenID userinfo
const uiRes = await fetch('https://api.linkedin.com/v2/userinfo', {
  headers: { Authorization: `Bearer ${tok.access_token}` },
});
const ui = await uiRes.json();
if (!ui.sub) throw new Error('userinfo failed: ' + JSON.stringify(ui));
console.log('person:', ui.name, '(' + ui.sub + ')');

const expiresAt = Math.floor(Date.now() / 1000) + (tok.expires_in || 0);
const kv = {
  [`LINKEDIN_ACCESS_TOKEN${SFX}`]: tok.access_token,
  [`LINKEDIN_PERSON_URN${SFX}`]: `urn:li:person:${ui.sub}`,
  [`LINKEDIN_TOKEN_EXPIRES${SFX}`]: String(expiresAt),
};
if (tok.refresh_token) kv[`LINKEDIN_REFRESH_TOKEN${SFX}`] = tok.refresh_token;
writeFileSync(ENV, upsertEnv(existsSync(ENV) ? readFileSync(ENV, 'utf8') : '', kv));
console.log(`saved to .env (account ${label(account)}): ` + Object.keys(kv).join(', ') + (tok.refresh_token ? '' : ' (no refresh_token issued)'));
