#!/usr/bin/env node
/**
 * Card renderer — a card spec (JSON) becomes Instagram-sized images.
 *
 *   node gen-cards.mjs <slug>            # 1080×1350 carousel cards → $CROSSPOST_HOME/media/<slug>/card-NN.jpg
 *   node gen-cards.mjs <slug> --reels    # 1080×1920 frames        → $CROSSPOST_HOME/build/<slug>/reel-NN.jpg
 *   node gen-cards.mjs <slug> --open     # also print the HTML path for eyeballing
 *
 * Instagram is the only channel here that cannot publish text, so every post needs images.
 * This renders them from a spec you (or Claude) write to
 * `$CROSSPOST_HOME/cards/<slug>.json`:
 *
 *   { "format": "carousel",
 *     "cards": [
 *       { "type": "cover", "eyebrow": "Build log", "headline": "…", "subject": "crosspost" },
 *       { "type": "stat", "value": "3.4s", "label": "…", "note": "…" },
 *       { "type": "body", "heading": "…", "items": ["…", "…"] },
 *       { "type": "checklist", "heading": "…", "items": ["…"] },
 *       { "type": "quote", "quote": "…", "attribution": "…" } ] }
 *
 * Theme: neutral by default; drop `$CROSSPOST_HOME/cards.theme.json` to override any token
 * ({"ink":"#101418","paper":"#fbfaf7","accent":"#c2410c","fontStack":"…"}). Nothing is fetched
 * at render time — no web fonts, no network — so a render is reproducible offline.
 *
 * Overflow is measured in the page rather than estimated from character counts: a per-language
 * character-width table is exactly the kind of thing that silently stops matching reality.
 * If a card's content is taller than its box, this fails loudly instead of shipping a clipped
 * card that cannot be replaced after publishing.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { loadEnv, home, dataPath } from '../lib/env.mjs';
import { validate } from './card-rules.mjs';

loadEnv();

const args = process.argv.slice(2);
const REELS = args.includes('--reels');
const slug = args.find((a) => !a.startsWith('--'));
if (!slug) { console.error('usage: node gen-cards.mjs <slug> [--reels]'); process.exit(1); }

const W = 1080;
const H = REELS ? 1920 : 1350;
// Reels overlay chrome (caption block, action rail) covers the bottom and right of the frame.
// Text placed there is simply not readable in the app, so the frame keeps it clear.
const SAFE = REELS ? { bottom: 340, right: 200 } : { bottom: 96, right: 96 };
const SPEC_PATH = dataPath(`cards/${slug}.json`);
const OUT_DIR = REELS ? dataPath(`build/${slug}`) : dataPath(`media/${slug}`);
const STEM = REELS ? 'reel' : 'card';

if (!existsSync(SPEC_PATH)) { console.error(`no card spec: ${SPEC_PATH}`); process.exit(1); }
const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
const format = REELS ? 'reels' : (spec.format || 'carousel');

const { errors, warnings } = validate(spec, { format });
for (const w of warnings) console.error(`  warn: ${w}`);
if (errors.length) {
  console.error('card spec rejected:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const THEME = {
  ink: '#12151a',
  paper: '#faf9f6',
  accent: '#c2410c',
  muted: '#6b7280',
  hairline: '#e5e1d8',
  fontStack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', Roboto, sans-serif`,
  monoStack: `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace`,
};
try { Object.assign(THEME, JSON.parse(readFileSync(join(home(), 'cards.theme.json'), 'utf8'))); } catch { /* defaults */ }

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const scale = REELS ? 1.2 : 1; // reels are viewed smaller and in motion — type goes up
const px = (n) => `${Math.round(n * scale)}px`;

const cardBody = (card, i, n) => {
  switch (card.type) {
    case 'cover':
      return `
        ${card.eyebrow ? `<div class="eyebrow">${esc(card.eyebrow)}</div>` : ''}
        <h1 class="headline">${esc(card.headline)}</h1>
        ${card.sub ? `<p class="sub">${esc(card.sub)}</p>` : ''}`;
    case 'stat':
      return `
        ${card.label ? `<div class="eyebrow">${esc(card.label)}</div>` : ''}
        <div class="stat">${esc(card.value)}</div>
        ${card.note ? `<p class="note">${esc(card.note)}</p>` : ''}`;
    case 'quote':
      return `
        <blockquote class="quote">${esc(card.quote)}</blockquote>
        ${card.attribution ? `<div class="attribution">${esc(card.attribution)}</div>` : ''}`;
    case 'checklist':
      return `
        ${card.heading ? `<h2 class="heading">${esc(card.heading)}</h2>` : ''}
        <ul class="checklist">${(card.items || []).map((it) => `<li>${esc(it)}</li>`).join('')}</ul>`;
    default: // body
      return `
        ${card.heading ? `<h2 class="heading">${esc(card.heading)}</h2>` : ''}
        ${card.text ? `<p class="text">${esc(card.text)}</p>` : ''}
        ${card.items?.length ? `<ul class="list">${card.items.map((it) => `<li>${esc(it)}</li>`).join('')}</ul>` : ''}`;
  }
};

const html = (card, i, n) => `<!doctype html><meta charset="utf-8"><style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${W}px; height: ${H}px; }
  body {
    font-family: ${THEME.fontStack};
    background: ${THEME.paper}; color: ${THEME.ink};
    -webkit-font-smoothing: antialiased;
  }
  .frame {
    width: ${W}px; height: ${H}px; display: flex; flex-direction: column;
    padding: ${px(96)} ${SAFE.right}px ${SAFE.bottom}px ${px(96)};
  }
  .frame.invert { background: ${THEME.ink}; color: ${THEME.paper}; }
  .content { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: ${px(28)}; overflow: hidden; }
  .eyebrow {
    font-family: ${THEME.monoStack}; font-size: ${px(30)}; letter-spacing: .12em;
    text-transform: uppercase; color: ${THEME.accent};
  }
  .headline { font-size: ${px(84)}; line-height: 1.16; font-weight: 700; letter-spacing: -.02em; }
  .sub { font-size: ${px(38)}; line-height: 1.5; color: ${THEME.muted}; }
  .stat { font-size: ${px(180)}; line-height: 1; font-weight: 700; letter-spacing: -.03em; color: ${THEME.accent}; }
  .note, .text { font-size: ${px(40)}; line-height: 1.55; }
  .heading { font-size: ${px(58)}; line-height: 1.25; font-weight: 700; }
  .quote { font-size: ${px(62)}; line-height: 1.35; font-weight: 600; }
  .quote::before { content: '“'; color: ${THEME.accent}; }
  .quote::after { content: '”'; color: ${THEME.accent}; }
  .attribution { font-size: ${px(34)}; color: ${THEME.muted}; }
  ul { list-style: none; display: flex; flex-direction: column; gap: ${px(22)}; }
  li { font-size: ${px(40)}; line-height: 1.45; padding-left: ${px(46)}; position: relative; }
  li::before { position: absolute; left: 0; color: ${THEME.accent}; }
  .list li::before { content: '—'; }
  .checklist li::before { content: '✓'; font-weight: 700; }
  .footer {
    display: flex; justify-content: space-between; align-items: baseline;
    font-family: ${THEME.monoStack}; font-size: ${px(26)}; color: ${THEME.muted};
    border-top: 1px solid ${THEME.hairline}; padding-top: ${px(24)};
  }
  .frame.invert .footer { border-color: rgba(255,255,255,.18); }
</style>
<div class="frame${card.invert ? ' invert' : ''}">
  <div class="content" id="content">${cardBody(card, i, n)}</div>
  <div class="footer"><span>${esc(card.subject || spec.subject || '')}</span><span>${i + 1} / ${n}</span></div>
</div>`;

mkdirSync(OUT_DIR, { recursive: true });
// 이전 렌더의 잔여 프레임 제거 — spec의 카드 수가 줄면 stale 프레임이 남고,
// post-api는 디렉터리 글롭으로, gen-reel은 전체 concat으로 그걸 그대로 발행한다.
// STEM 매칭 파일만 지운다(캐러셀 OUT_DIR엔 reel.mp4가 같이 있을 수 있다).
for (const f of readdirSync(OUT_DIR).filter((n) => new RegExp(`^${STEM}-\\d+\\.jpg$`).test(n))) {
  unlinkSync(join(OUT_DIR, f));
}
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

// 스크린샷은 버퍼로만 캡처하고, 오버플로 판정이 끝난 뒤에야 OUT_DIR에 쓴다.
// 잘린 렌더를 발행 디렉터리에 남기면 check-cards가 오버플로를 재측정하지 않아
// 게이트를 통과하고, IG는 발행 후 교체가 불가라 영구다.
const shots = [];
const overflowed = [];
for (const [i, card] of spec.cards.entries()) {
  await page.setContent(html(card, i, spec.cards.length), { waitUntil: 'load' });
  // measured, not estimated — see the header note
  const over = await page.evaluate(() => {
    const el = document.getElementById('content');
    return el.scrollHeight - el.clientHeight;
  });
  if (over > 2) overflowed.push(`card ${i + 1} overflows its box by ${over}px — shorten the text`);
  shots.push({
    name: `${STEM}-${String(i + 1).padStart(2, '0')}.jpg`,
    buf: await page.screenshot({ type: 'jpeg', quality: 90 }),
  });
}
await browser.close();

if (overflowed.length) {
  const clipDir = join(home(), 'build', `${slug}-clipped`);
  mkdirSync(clipDir, { recursive: true });
  for (const s of shots) writeFileSync(join(clipDir, s.name), s.buf);
  console.error('\nrendered, but these cards are clipped — nothing was written to the publish directory:');
  for (const o of overflowed) console.error(`  - ${o}`);
  console.error(`clipped renders (inspection only): ${clipDir.replace(home(), '$CROSSPOST_HOME')}`);
  console.error('Instagram cannot replace media after publishing — fix the spec and re-render.');
  process.exit(1);
}

for (const s of shots) {
  writeFileSync(join(OUT_DIR, s.name), s.buf);
  console.log(`  ${join(OUT_DIR, s.name).replace(home(), '$CROSSPOST_HOME')}`);
}

console.log(`\n${shots.length} ${REELS ? 'reel frames' : 'cards'} written to ${OUT_DIR.replace(home(), '$CROSSPOST_HOME')}`);
if (!REELS) {
  console.log('Publish that directory so Meta can fetch it, then set CROSSPOST_MEDIA_BASE_URL.');
}
