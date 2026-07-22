// Shared CDP tab management for the naver-blog scripts. Reuses an existing reusable
// tab instead of piling up a new one every run — the persistent browser is shared
// with brunch/linkedin/remember/facebook, so we NEVER hijack their tabs; we only
// reuse an about:blank or a naver-owned tab (or create one if none).
import { chromium } from 'playwright';
import { cdpPort } from '../lib/env.mjs';

const CDP = `http://127.0.0.1:${cdpPort()}`;
// naver-owned pages that are safe to reuse (navigate away from) — blog / stat / login.
const NAVER_RE = /^https?:\/\/([a-z0-9-]+\.)*(blog\.naver|admin\.blog\.naver|blog\.stat\.naver|nid\.naver|m\.blog\.naver)\.com/i;

export async function connect() {
  const browser = await chromium.connectOverCDP(CDP, { noDefaults: true });
  return { browser, ctx: browser.contexts()[0] };
}

// Reap leftover tabs so the shared browser doesn't accumulate to the point of
// hanging CDP (other channels open tabs and don't always close them; over a
// session they pile up to 30+). Tabs hold no session (cookies live in the
// persistent profile), so CLOSING an idle non-naver, non-blank tab is safe —
// that channel just re-opens one next run. We only close beyond `max`, and
// never our own reusable tabs (about:blank / naver-owned), so this stays well
// clear of normal parallel-stats usage and only bites a runaway pile-up.
export async function reapTabs(ctx, { max = 8 } = {}) {
  if (ctx.pages().length <= max) return 0;
  let closed = 0;
  for (const p of ctx.pages()) {
    if (ctx.pages().length <= max) break;
    const u = p.url();
    if (!u || u === 'about:blank' || NAVER_RE.test(u)) continue; // keep reusable/naver tabs
    try { await p.close(); closed++; } catch {}
  }
  return closed;
}

// Reuse-first: prefer an existing about:blank, then a naver-owned tab, else create one.
export async function acquirePage(ctx) {
  await reapTabs(ctx).catch(() => {}); // clear other channels' pile-up before we work
  const pages = ctx.pages();
  const blank = pages.find((p) => p.url() === 'about:blank' || p.url() === '');
  if (blank) return blank;
  const naver = pages.find((p) => NAVER_RE.test(p.url()));
  if (naver) return naver;
  return ctx.newPage();
}

// Release by parking the tab on about:blank (reusable next run) instead of closing it —
// so tabs don't accumulate AND the next run reuses this same tab. Falls back to close
// only if parking fails (e.g. a stuck dialog).
export async function releasePage(page) {
  try { await page.goto('about:blank', { timeout: 5000 }); }
  catch { try { await page.close(); } catch {} }
}

// Run fn with a reused page; parks it on release, disconnects (does not kill the browser).
export async function withPage(fn, { onDialog } = {}) {
  const { browser, ctx } = await connect();
  const page = await acquirePage(ctx);
  if (onDialog) page.on('dialog', onDialog);
  try { return await fn(page, ctx); }
  finally { await releasePage(page); await browser.close().catch(() => {}); }
}
