// Shared browserless session-cookie acquisition for the stats/publish paths that talk to
// sites with no API (LinkedIn analytics, Naver Blog).
//
// Same shape as the Remember token helper: env first (browserless), CDP capture as the
// self-heal fallback, and a freshly captured value is persisted to $CROSSPOST_HOME/.env so
// the next run needs no browser. These sites authenticate with plain cookies, so the stored
// payload is a ready-to-send `Cookie:` header string rather than a bearer token.
//
// IMPORTANT: keep the captured cookie set MINIMAL (the `names` option). Sending every cookie
// the browser profile holds makes LinkedIn answer 400 with an empty body (measured
// 2026-07-27: li_at alone → 200/1.1MB, a full 29-cookie profile string → 400/0). Fewer names
// is not an optimization here — it is the difference between working and not.
import fs from 'node:fs';
import path from 'node:path';
import { home } from './env.mjs';

const envFile = () => path.join(home(), '.env');

export function envCookie(key) {
  if (process.env[key]) return process.env[key];
  try {
    return (fs.readFileSync(envFile(), 'utf8').match(new RegExp(`^${key}="?([^"\\n]+)`, 'm')) || [])[1] || null;
  } catch { return null; }
}

export function persistCookie(key, value) {
  if (!key || !value) return;
  try {
    const p = envFile();
    let env = '';
    try { env = fs.readFileSync(p, 'utf8'); } catch {}
    const line = `${key}="${value}"`;
    if (new RegExp(`^${key}=`, 'm').test(env)) env = env.replace(new RegExp(`^${key}=.*$`, 'm'), line);
    else env += (!env || env.endsWith('\n') ? '' : '\n') + line + '\n';
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, env, { mode: 0o600 });
  } catch { /* non-fatal — the run still has the value in memory */ }
}

// Read the named cookies out of the logged-in CDP profile without rendering anything.
// `chromium` is passed in by the caller so this module never has to resolve playwright itself.
export async function captureCookieViaCDP({ port = 9224, origins, names, chromium }) {
  const pw = chromium || (await import('playwright')).chromium;
  const browser = await pw.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
  try {
    const ctx = browser.contexts()[0];
    const cookies = await ctx.cookies(origins);
    const picked = names
      .map((n) => cookies.find((c) => c.name === n))
      .filter(Boolean)
      .map((c) => `${c.name}=${c.value}`);
    return picked.length ? picked.join('; ') : null;
  } finally {
    await browser.close(); // disconnect only — the shared browser keeps running
  }
}

// env → (validate) → CDP capture → persist. `validate` is optional but recommended: without
// it an expired cookie in .env silently yields empty stats instead of self-healing.
export async function resolveCookie({ key, port = 9224, origins, names, validate, chromium }) {
  const fromEnv = envCookie(key);
  if (fromEnv && (!validate || (await validate(fromEnv)))) return { cookie: fromEnv, src: 'env' };

  let fresh = null;
  try {
    fresh = await captureCookieViaCDP({ port, origins, names, chromium });
  } catch (e) {
    if (fromEnv) return { cookie: fromEnv, src: 'env (stale; CDP capture failed)' };
    throw new Error(`CDP :${port} cookie capture failed — a logged-in browser is required (${e.message.slice(0, 60)})`);
  }
  if (!fresh) {
    if (fromEnv) return { cookie: fromEnv, src: 'env (stale; no cookie in profile)' };
    throw new Error(`no ${names.join('/')} cookie in the CDP :${port} profile — log in to the site first`);
  }
  if (validate && !(await validate(fresh))) {
    throw new Error('captured cookie still fails auth — log in again in the browser');
  }
  persistCookie(key, fresh);
  return { cookie: fresh, src: 'cdp (captured, persisted)' };
}
