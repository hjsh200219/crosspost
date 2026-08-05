// Shared Brunch session acquisition for stats.mjs (browserless steady-state).
//
// Brunch has no bearer token and no official API — auth is the .brunch.co.kr session
// cookie set (bid/b_s_a_l/__T_*/_T_ANO). The API (api.brunch.co.kr) accepts a plain
// node fetch as long as the request carries a full Chrome User-Agent + Referer; a
// bare Cookie-only request is rejected 401 as a bot. Source order:
//   1) env BRUNCH_COOKIE (process.env, else $CROSSPOST_HOME/.env; stored base64) → browserless
//   2) CDP (:9224) — navigate /kakao/login to silently re-mint the brunch session off
//      the still-live Kakao SSO (human-free), then read the .brunch.co.kr cookies.
// A freshly captured cookie is persisted to $CROSSPOST_HOME/.env so subsequent runs are
// browserless. Human Kakao login is only needed when the Kakao SSO itself dies (months out).
import { readFileSync, writeFileSync } from 'fs';
import { cdpPort } from '../lib/env.mjs';

// A realistic desktop Chrome UA is REQUIRED — the brunch API 401s requests without one.
export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

export function apiHeaders(cookie) {
  return { Cookie: cookie, 'User-Agent': UA, Referer: 'https://brunch.co.kr/', 'Accept-Language': 'en-US,en;q=0.9' };
}

/**
 * Carry the form-login (tier 3) outcome into the failure message.
 *
 * Anything other than `KAKAO_2FA` used to be swallowed by a bare `catch {}`, leaving only the
 * generic "log in by hand" line. That made **"the form login never ran"** and **"the login
 * worked but the session is still 401"** print the same sentence — and when the same form
 * login then passed on its own a minute later, there was nothing left to tell the two apart
 * after the fact. Print the reason to stderr immediately (scheduled runs keep only stderr)
 * and attach it to the final error.
 */
function tier3Reason(e) {
  const why = `${e?.code || 'ERR'}: ${String(e?.message || e).split('\n')[0].slice(0, 160)}`;
  console.error(`  ! tier-3 Kakao form login failed — ${why}`);
  return why;
}

function tier3Note(tier3) {
  if (tier3 === 'ok') return 'form login succeeded but the session is still invalid — the Kakao account is alive, only the Brunch session will not attach';
  if (tier3) return `form login failed — ${tier3}`;
  return 'form login not attempted';
}

// Cookie strings contain ';', ' ' and embedded '"' (bid="..."), so we store them
// base64-encoded in .env to sidestep all quoting. A raw cookie (manual override)
// still works: base64 never contains ';' or ' ', a real cookie always does.
function decodeCookie(v) {
  if (!v) return null;
  const s = v.trim();
  if (/[;\s]/.test(s)) return s; // clearly a raw cookie
  try { const dec = Buffer.from(s, 'base64').toString('utf8'); if (dec.includes('=')) return dec; } catch {}
  return s;
}

export function envFileCookie(envPath) {
  if (process.env.BRUNCH_COOKIE) return decodeCookie(process.env.BRUNCH_COOKIE);
  try {
    const raw = (readFileSync(envPath, 'utf8').match(/^BRUNCH_COOKIE="?([^"\n]+)/m) || [])[1];
    return decodeCookie(raw);
  } catch { return null; }
}

function upsertEnv(env, key, val) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(env)) return env.replace(re, `${key}=${val}`);
  return env + (!env || env.endsWith('\n') ? '' : '\n') + `${key}=${val}\n`;
}

export function persistCookie(cookie, envPath) {
  if (!cookie || !envPath) return;
  const b64 = Buffer.from(cookie, 'utf8').toString('base64');
  try {
    let env = '';
    try { env = readFileSync(envPath, 'utf8'); } catch {}
    env = upsertEnv(env, 'BRUNCH_COOKIE', b64);
    // stamp capture time so the next expiry can log how long the cookie actually lasted
    // (brunch session TTL is unmeasured; this turns it into data over time).
    env = upsertEnv(env, 'BRUNCH_COOKIE_TS', new Date().toISOString());
    writeFileSync(envPath, env);
  } catch {}
}

// ISO timestamp of the last cookie capture (for TTL logging), or null.
export function envFileCookieTs(envPath) {
  try { return (readFileSync(envPath, 'utf8').match(/^BRUNCH_COOKIE_TS=([^\n]+)/m) || [])[1] || null; }
  catch { return null; }
}

// Browserless auth probe. Returns me.data ({ userId, profileId, ... }) or null on 401.
export async function fetchMe(cookie) {
  try {
    const r = await fetch('https://api.brunch.co.kr/v2/me', { headers: apiHeaders(cookie) });
    if (r.status !== 200) return null;
    return (await r.json().catch(() => null))?.data ?? null;
  } catch { return null; }
}

// CDP (:9224) → fresh .brunch.co.kr cookie string. Navigates /kakao/login first so the
// live Kakao SSO silently re-mints the brunch app session (the homepage does NOT), then
// reads the cookies scoped to api.brunch.co.kr. Verifies the capture is authenticated;
// throws (Kakao SSO dead → human login) otherwise.
export async function captureCookieViaCDP(port = cdpPort()) {
  const { chromium } = await import('playwright');
  let browser;
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true }); }
  catch { throw new Error(`CDP browser not running (:${port}) — start it with \`npm run browser\`, log into Kakao, then retry.`); }
  try {
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.bringToFront();
    // Silent re-mint off live Kakao SSO. Use /auth/kakao?url= (the real brunch OAuth
    // entry that mints the `bid` session cookie), NOT /kakao/login — the latter only
    // bounces #error:alreadyConnectedToExistingUser and never sets `bid` when the cookie
    // has fully expired, so cold self-heal silently failed. /auth/kakao lands back on
    // brunch.co.kr/ with `bid` set when the SSO is alive; if the SSO is dead it stops on
    // the Kakao login page and the bid check below throws (same human-login fallback).
    await page.goto('https://brunch.co.kr/auth/kakao?url=https%3A%2F%2Fbrunch.co.kr%2F', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    let cks = await ctx.cookies('https://api.brunch.co.kr');
    let cookie = cks.map((c) => `${c.name}=${c.value}`).join('; ');
    let tier3 = null;  // null = not attempted · 'ok' = login succeeded · otherwise the reason
    if (!/\bbid=/.test(cookie)) {
      // Kakao SSO itself is dead (~monthly). Deepest tier: form login with KAKAO_ID/PW.
      // Works human-free while the profile keeps Kakao's device-trust cookies (2FA skipped);
      // if a 2FA/device-approval wall appears, loginViaKakao throws KAKAO_2FA → human fallback.
      try {
        const { loginViaKakao } = await import('./kakao-login.mjs');
        await loginViaKakao(port);
        tier3 = 'ok';
        cks = await ctx.cookies('https://api.brunch.co.kr');
        cookie = cks.map((c) => `${c.name}=${c.value}`).join('; ');
      } catch (e) {
        if (e.code === 'KAKAO_2FA') {
          throw new Error('Kakao 2FA/device verification required — `npm run browser` and re-login to Kakao (approve on phone).');
        }
        tier3 = tier3Reason(e);   // NO_CREDS / NO_CDP / NOT_AUTHED / other
      }
    }
    if (!cookie || !/\bbid=/.test(cookie)) {
      throw new Error(`no Brunch session cookie (${tier3Note(tier3)}) — Kakao login required (npm run browser → log into Kakao).`);
    }
    if (!(await fetchMe(cookie))) {
      throw new Error(`Brunch session re-mint failed (${tier3Note(tier3)}) — npm run browser → re-login to Kakao.`);
    }
    return cookie;
  } finally {
    await browser.close();
  }
}

// Resolve a cookie: env first (browserless), else CDP capture (+persist).
// Returns { cookie, src: 'env' | 'cdp' }.
export async function getCookie({ envPath, port = cdpPort() } = {}) {
  const envCk = envFileCookie(envPath);
  if (envCk) return { cookie: envCk, src: 'env' };
  const cookie = await captureCookieViaCDP(port);
  persistCookie(cookie, envPath);
  return { cookie, src: 'cdp' };
}

// --- Authenticated Brunch API client (in-page fetch) ---------------------------
//
// Why not a cookie string + node fetch? The api.brunch.co.kr session cookie
// authenticates ONLY when the request is issued from a live brunch.co.kr document
// (page.evaluate fetch). The IDENTICAL cookie bytes (Playwright- or CDP-raw) sent by a
// node/undici fetch — or even Playwright's own APIRequestContext — return 401. There is
// no custom auth header and no service worker to replicate (verified 2026-07-10): the
// browser's network stack is the differentiator, so no cookie-string fix exists.
// Therefore stats issue every brunch call via page.evaluate on the CDP (:9224) page.
//
// The env BRUNCH_COOKIE fast path is kept only as an opportunistic optimization: if a
// plain node fetch to /v2/me ever 200s again (brunch reverting), it's used browserless;
// otherwise we fall straight to the in-page path. Validity is gated on /v2/me == 200
// (the old `/\bbid=/` presence gate was meaningless — bid exists on anonymous sessions,
// which is what fired the false "Kakao SSO 만료" error while the browser was authenticated).

async function nodeGet(url, cookie) {
  try { const r = await fetch(url, { headers: apiHeaders(cookie) }); return { status: r.status, text: await r.text() }; }
  catch { return { status: 0, text: '' }; }
}

// Fetch from inside the brunch.co.kr document (the only path that authenticates).
async function pageGet(page, url) {
  return await page.evaluate(async (u) => {
    try { const r = await fetch(u, { credentials: 'include' }); return { status: r.status, text: await r.text() }; }
    catch { return { status: 0, text: '' }; }
  }, url);
}

async function remintAndProbe(page) {
  // /auth/kakao?url= re-authenticates the brunch app off the live Kakao SSO (the homepage
  // does not). Then confirm with an in-page /v2/me — the real validity check.
  await page.goto('https://brunch.co.kr/auth/kakao?url=https%3A%2F%2Fbrunch.co.kr%2F', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const r = await pageGet(page, 'https://api.brunch.co.kr/v2/me');
  if (r.status !== 200) return null;
  try { return JSON.parse(r.text)?.data ?? null; } catch { return null; }
}

// Returns an authenticated brunch client: { me, src, get(url)→{status,text}, close() }.
// `get` is path-agnostic (browserless env or in-page CDP) so callers don't branch.
export async function openBrunch({ envPath, port = cdpPort() } = {}) {
  // 1) opportunistic browserless fast path (validated, not assumed)
  const envCk = envFileCookie(envPath);
  if (envCk) {
    const me = await fetchMe(envCk);
    if (me?.userId) {
      return { me, src: 'env', get: (url) => nodeGet(url, envCk), close: async () => {} };
    }
  }

  // 2) in-page path: CDP :9224 → re-mint → in-page /v2/me gate → tier3 form-login retry
  const { chromium } = await import('playwright');
  let browser;
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true }); }
  catch { throw new Error(`CDP browser not running (:${port}) — start it with \`npm run browser\`, log into Kakao, then retry.`); }
  try {
    const ctx = browser.contexts()[0];
    const page = ctx.pages().find((p) => p.url().includes('brunch.co.kr')) || (await ctx.newPage());
    await page.bringToFront();

    let me = await remintAndProbe(page);
    let tier3 = null;  // null = not attempted · 'ok' = login succeeded · otherwise the reason
    if (!me?.userId) {
      // Kakao SSO may need a fresh login. Tier3 form login (KAKAO_ID/PW + device trust),
      // then re-probe. A 2FA/device wall → human fallback.
      try {
        const { loginViaKakao } = await import('./kakao-login.mjs');
        await loginViaKakao(port);
        tier3 = 'ok';
        me = await remintAndProbe(page);
      } catch (e) {
        if (e.code === 'KAKAO_2FA') {
          throw new Error('Kakao 2FA/device verification required — `npm run browser` and re-login to Kakao (approve on phone).');
        }
        tier3 = tier3Reason(e);   // NO_CREDS / NO_CDP / NOT_AUTHED / other
      }
    }
    if (!me?.userId) {
      throw new Error(`Brunch session auth failed (${tier3Note(tier3)}) — npm run browser → re-login to Kakao.`);
    }
    return { me, src: 'cdp', get: (url) => pageGet(page, url), close: async () => { await browser.close(); } };
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}
