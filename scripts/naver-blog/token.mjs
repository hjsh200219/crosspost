// Shared Naver token handling for auth.mjs / post-api.mjs.
// OAuth2 (authorization code). auth.mjs runs the one-time login flow and writes
// NAVER_BLOG_ACCESS_TOKEN / _REFRESH_TOKEN / _TOKEN_EXPIRES into $CROSSPOST_HOME/.env.
// post-api.mjs calls getAccessToken(), which auto-refreshes when near expiry.
// Token values are never logged in full.
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { home } from '../lib/env.mjs';

const ENV = path.join(home(), '.env');
const TOKEN_URL = 'https://nid.naver.com/oauth2.0/token';
const SKEW = 300; // refresh when <5 min to expiry

// Read one key from .env (quoted or unquoted value). Re-reads each call so writes
// from upsertEnv are immediately visible.
export function env(key) {
  let text = '';
  try { text = readFileSync(ENV, 'utf8'); } catch { text = ''; }
  return (text.match(new RegExp(`^${key}="?([^"\\n]+)`, 'm')) || [])[1];
}

// Replace the KEY=... line in .env, or append it if absent.
export function upsertEnv(key, value) {
  let text = '';
  try { text = readFileSync(ENV, 'utf8'); } catch {}
  const line = `${key}="${value}"`;
  text = new RegExp(`^${key}=.*$`, 'm').test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, 'm'), () => line)
    : text.replace(/\n*$/, '\n') + line + '\n';
  writeFileSync(ENV, text);
}

// Exchange the stored refresh_token for a fresh access_token; persist and return it.
// Naver may omit refresh_token in the response — keep the existing one when it does.
export async function refreshAccessToken() {
  const clientId = env('NAVER_BLOG_CLIENT_ID');
  const clientSecret = env('NAVER_BLOG_CLIENT_SECRET');
  const refreshToken = env('NAVER_BLOG_REFRESH_TOKEN');
  if (!clientId || !clientSecret || !refreshToken)
    throw new Error('values required for refresh missing in .env (NAVER_BLOG_CLIENT_ID/SECRET/REFRESH_TOKEN) — re-run node auth.mjs');
  const qs = new URLSearchParams({
    grant_type: 'refresh_token', client_id: clientId,
    client_secret: clientSecret, refresh_token: refreshToken,
  });
  const res = await fetch(`${TOKEN_URL}?${qs}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.access_token)
    throw new Error(`token refresh failed (${data.error || res.status}: ${data.error_description || ''}) — re-run node auth.mjs`);
  upsertEnv('NAVER_BLOG_ACCESS_TOKEN', data.access_token);
  upsertEnv('NAVER_BLOG_TOKEN_EXPIRES', String(Math.floor(Date.now() / 1000) + Number(data.expires_in || 0)));
  if (data.refresh_token) upsertEnv('NAVER_BLOG_REFRESH_TOKEN', data.refresh_token);
  return data.access_token;
}

// Return a usable access token: the stored one if still fresh, else a refreshed one.
export async function getAccessToken() {
  const token = env('NAVER_BLOG_ACCESS_TOKEN');
  const expires = Number(env('NAVER_BLOG_TOKEN_EXPIRES') || 0);
  if (!token) {
    if (env('NAVER_BLOG_REFRESH_TOKEN')) return refreshAccessToken();
    throw new Error('NAVER_BLOG_ACCESS_TOKEN missing in .env — run node auth.mjs first');
  }
  if (expires && Math.floor(Date.now() / 1000) >= expires - SKEW) return refreshAccessToken();
  return token;
}
