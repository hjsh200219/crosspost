// Deepest brunch self-heal tier: full Kakao form login when the SSO cookie itself is dead.
//
// Tier ladder (see cookie.mjs): env BRUNCH_COOKIE  →  CDP /auth/kakao remint (SSO alive)
//   →  THIS: form login with KAKAO_ID/KAKAO_PW on accounts.kakao.com (SSO dead, ~monthly).
//
// Credentials live in $CROSSPOST_HOME/.env (KAKAO_ID / KAKAO_PW), same file as every
// other channel's credentials — see lib/env.mjs.
//
// The one wall that cannot be automated is a 2FA / device-approval push — if Kakao shows it,
// this throws { code: 'KAKAO_2FA' } so the caller falls back to human `npm run browser`.
//
// Never logs the password. CDP browser (:9224) must be running.
import { loadEnv, cdpPort } from '../lib/env.mjs';

loadEnv();

const AUTH_URL = 'https://brunch.co.kr/auth/kakao?url=https%3A%2F%2Fbrunch.co.kr%2F';

// Signatures that a 2FA / new-device verification wall (human-only) is on screen.
const TWOFA_RE = /인증번호|인증 번호|2단계|카카오톡으로 인증|이메일로 인증|추가 인증|본인 확인|기기 등록.*인증|verification code|verify it.?s you/i;

export async function loginViaKakao(port = cdpPort(), { verbose = false } = {}) {
  const id = process.env.KAKAO_ID;
  const pw = process.env.KAKAO_PW;
  if (!id || !pw) throw Object.assign(new Error('KAKAO_ID/KAKAO_PW 미설정 ($CROSSPOST_HOME/.env)'), { code: 'NO_CREDS' });

  const { chromium } = await import('playwright');
  let browser;
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true }); }
  catch { throw Object.assign(new Error(`CDP 브라우저 미기동 (:${port})`), { code: 'NO_CDP' }); }

  const log = (...a) => { if (verbose) console.error(...a); };
  try {
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.bringToFront();
    await page.goto(AUTH_URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1200);

    // NOTE: do NOT early-return on hasBid here — `bid` is set on anonymous sessions too,
    // so a live-SSO probe by bid is a false positive that skips the form when the SSO is
    // actually dead. If the SSO is alive, /auth/kakao lands back on brunch.co.kr and the
    // accounts.kakao.com block below is simply skipped, then the loop returns LOGGED_IN.

    // Fill the Kakao login form if present.
    if (/accounts\.kakao\.com/.test(page.url())) {
      log('kakao login form — filling');
      const idSel = 'input[name=loginId], #loginId--1, input[type=text][autocomplete="username"], input[type=text]';
      const pwSel = 'input[name=password], #password--2, input[type=password]';
      await page.waitForSelector(idSel, { timeout: 15000 });
      await page.fill(idSel, id);
      await page.fill(pwSel, pw);
      // Keep-login checkbox extends the SSO lifetime → fewer future re-logins.
      const keep = await page.$('input[type=checkbox]');
      if (keep) { const checked = await keep.isChecked().catch(() => false); if (!checked) await keep.check({ force: true }).catch(() => {}); }
      // Submit: the highlighted submit button, else the button whose text is 로그인.
      const submit = await page.$('button[type=submit].submit, button.btn_g.highlight.submit, button[type=submit]');
      if (submit) {
        await submit.click().catch(() => {});
      } else {
        for (const e of await page.$$('button')) {
          const t = ((await e.innerText().catch(() => '')) || '').trim();
          if (/^로그인$/.test(t)) { await e.click().catch(() => {}); break; }
        }
      }
      await page.waitForTimeout(3500);
    }

    // Post-submit: walk through consent / device-registration screens; bail on 2FA.
    // Past the early ALREADY return above, bid was absent — any success here is a fresh login.
    for (let i = 0; i < 6; i++) {
      if (await hasBid(ctx)) return 'LOGGED_IN';
      const u = page.url();
      const bodyTxt = (await page.evaluate(() => document.body?.innerText || '').catch(() => '')) || '';

      if (TWOFA_RE.test(bodyTxt)) {
        throw Object.assign(new Error('Kakao 2FA/기기인증 화면 — 사람 승인 필요'), { code: 'KAKAO_2FA' });
      }
      // "다른 기기에서 로그인" / 새 기기 등록 / scope 동의 → click the primary continue button.
      const btn = await page.$(
        'button:has-text("계속하기"), button:has-text("동의하고 계속하기"), button:has-text("확인"), button:has-text("등록"), button.btn_agree, a:has-text("계속")'
      );
      if (btn) { log('click continue:', (await btn.innerText().catch(() => '')).trim()); await btn.click().catch(() => {}); await page.waitForTimeout(3000); continue; }

      if (/brunch\.co\.kr/.test(u)) { await page.waitForTimeout(1500); continue; }
      // Nothing actionable and not on brunch yet → wait a beat.
      await page.waitForTimeout(1500);
    }

    if (await hasBid(ctx)) return 'LOGGED_IN';
    throw Object.assign(new Error('로그인 완주 실패 (bid 미발급)'), { code: 'NO_BID' });
  } finally {
    await browser.close();
  }
}

async function hasBid(ctx) {
  const cks = await ctx.cookies('https://api.brunch.co.kr');
  return cks.some((c) => c.name === 'bid');
}

// CLI: node kakao-login.mjs [--verbose]
if (import.meta.url === `file://${process.argv[1]}`) {
  const verbose = process.argv.includes('--verbose');
  loginViaKakao(cdpPort(), { verbose })
    .then((r) => { console.log('result:', r); process.exit(0); })
    .catch((e) => { console.error(`FAIL [${e.code || 'ERR'}]: ${e.message}`); process.exit(e.code === 'KAKAO_2FA' ? 3 : 2); });
}
