// Shared Remember API token acquisition for remember-post.mjs / remember-stats.mjs.
//
// Token = `Authorization: Token token=<32hex>`. The token lives in the remember_session
// cookie and is STABLE for the login-session lifetime (~13 days). Source order:
//   1) env REMEMBER_TOKEN (process.env, else $CROSSPOST_HOME/.env) → browserless
//   2) CDP (shared crosspost debug port) — read the remember_session cookie directly
//      (no page render, ~1s); fallback to rendering the feed and intercepting the
//      Authorization header.
// A freshly captured token is persisted to .env so subsequent runs are browserless.
import { readFileSync, writeFileSync } from 'fs';
import { cdpPort } from '../lib/env.mjs';

const FEED = 'https://connect.rememberapp.co.kr/feed';

export function authHeader(raw) {
  const v = (raw || '').trim();
  if (!v) return null;
  return v.toLowerCase().startsWith('token ') ? v : `Token token=${v}`;
}

export function toHex(raw) {
  return (String(raw || '').match(/[a-f0-9]{32}/) || [])[0] || null;
}

// remember_session cookie value (raw / url-decoded / base64) → 32-hex token.
export function extractToken(val) {
  if (!val) return null;
  const cands = [val];
  try { cands.push(decodeURIComponent(val)); } catch {}
  try { cands.push(Buffer.from(decodeURIComponent(val), 'base64').toString('utf8')); } catch {}
  try { cands.push(Buffer.from(val, 'base64').toString('utf8')); } catch {}
  for (const c of cands) { const m = c && c.match(/\b[a-f0-9]{32}\b/); if (m) return m[0]; }
  return null;
}

export function envFileToken(envPath) {
  if (process.env.REMEMBER_TOKEN) return process.env.REMEMBER_TOKEN;
  try {
    return (readFileSync(envPath, 'utf8').match(/^REMEMBER_TOKEN="?([^"\n]+)/m) || [])[1] || null;
  } catch { return null; }
}

export function persistToken(hex, envPath) {
  if (!hex || !envPath) return;
  try {
    let env = '';
    try { env = readFileSync(envPath, 'utf8'); } catch {}
    if (/^REMEMBER_TOKEN=/m.test(env)) env = env.replace(/^REMEMBER_TOKEN=.*$/m, `REMEMBER_TOKEN=${hex}`);
    else env += (!env || env.endsWith('\n') ? '' : '\n') + `REMEMBER_TOKEN=${hex}\n`;
    writeFileSync(envPath, env);
  } catch {}
}

// CDP → raw 32-hex token. Fast path reads the remember_session cookie (no
// render); falls back to rendering the feed and intercepting the Authorization header.
export async function captureTokenViaCDP(port = cdpPort()) {
  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
  const ctx = browser.contexts()[0];
  try {
    const cookies = await ctx.cookies(['https://connect.rememberapp.co.kr', 'https://rememberapp.co.kr']);
    const hex = extractToken(cookies.find((c) => c.name === 'remember_session')?.value);
    if (hex) { await browser.close(); return hex; }
  } catch {}
  const page = ctx.pages()[0] || await ctx.newPage();
  let auth = null;
  page.on('request', (req) => {
    if (auth) return;
    if (!req.url().includes('connect-api.rememberapp.co.kr')) return;
    const h = req.headers();
    if (h.authorization) auth = h.authorization;
  });
  await page.bringToFront();
  await page.goto(FEED, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 30 && !auth; i++) await page.waitForTimeout(500);
  if (!auth) { await page.reload({ waitUntil: 'domcontentloaded' }); for (let i = 0; i < 30 && !auth; i++) await page.waitForTimeout(500); }
  await browser.close();
  if (!auth) throw new Error('CDP token capture failed — check Remember login (npm run browser → sign in with Google).');
  return toHex(auth) || auth.replace(/^Token token=/, '');
}

// Resolve a token: env first (browserless), else CDP capture (+persist).
// Returns { hex, hdr, src: 'env' | 'cdp' }.
export async function getToken({ envPath, port = cdpPort() } = {}) {
  const envTok = envFileToken(envPath);
  if (envTok) return { hex: toHex(envTok) || envTok, hdr: authHeader(envTok), src: 'env' };
  const hex = await captureTokenViaCDP(port);
  persistToken(hex, envPath);
  return { hex, hdr: authHeader(hex), src: 'cdp' };
}
