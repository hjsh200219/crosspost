#!/usr/bin/env node
/**
 * Pre-publish gate for the Instagram channel.
 *
 *   node check-cards.mjs <slug> [--reels]
 *   node check-cards.mjs --all
 *
 * Instagram cannot replace media after publishing, so this is the last mechanical defence:
 * everything it catches is something that would otherwise be permanent. Run it before
 * `post-api.mjs` (or wire it into whatever runs the publish).
 *
 * It reuses card-rules.mjs for the spec and caption predicates — the same code the generator
 * runs — and adds the three things a spec file alone cannot tell you:
 *   1. rendered file count vs spec card count (a stale render is invisible in the JSON)
 *   2. the caption exists and fits
 *   3. the media the publisher will actually reference is present
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, dataPath, home } from '../lib/env.mjs';
import { canonicalLink } from '../lib/canonical-link.mjs';
import { playable } from '../lib/mp4.mjs';
import { validate, validateCaption } from './card-rules.mjs';

loadEnv();

const args = process.argv.slice(2);
const REELS = args.includes('--reels');
const ALL = args.includes('--all');
const one = args.find((a) => !a.startsWith('--'));
if (!one && !ALL) { console.error('usage: node check-cards.mjs <slug> [--reels] | --all'); process.exit(1); }

const POSTS = dataPath('posts');
const short = (p) => p.replace(home(), '$CROSSPOST_HOME');

function checkSlug(slug, reels) {
  const errors = [];
  const warnings = [];
  const format = reels ? 'reels' : 'carousel';

  // 1) spec
  const specPath = dataPath(`cards/${slug}.json`);
  let spec = null;
  if (existsSync(specPath)) {
    try { spec = JSON.parse(readFileSync(specPath, 'utf8')); } catch (e) { errors.push(`card spec is not valid JSON: ${e.message}`); }
  }
  if (spec) {
    const r = validate(spec, { format });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }

  // 2) rendered media — the count the publisher will use, not the count the spec claims
  const listFile = join(POSTS, `${slug}.insta.media`);
  const mediaDir = dataPath(`media/${slug}`);
  let rendered = 0;
  if (existsSync(listFile)) {
    rendered = readFileSync(listFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).length;
  } else if (reels) {
    // Playability, not existence — a half-written reel.mp4 from a killed ffmpeg run exists
    // and would sail through this gate straight into an unpublishable container (see lib/mp4.mjs).
    const reel = join(mediaDir, 'reel.mp4');
    rendered = playable(reel) ? 1 : 0;
    if (!rendered) {
      errors.push(existsSync(reel)
        ? `reel.mp4 in ${short(mediaDir)} is not playable (truncated render) — delete it and re-run gen-reel`
        : `no reel.mp4 in ${short(mediaDir)} — run gen-cards --reels then gen-reel`);
    }
  } else if (existsSync(mediaDir)) {
    rendered = readdirSync(mediaDir).filter((f) => /^card-\d+\.(jpg|jpeg|png)$/i.test(f)).length;
  }
  if (!rendered) errors.push(`no media found for "${slug}" (looked in ${short(mediaDir)} and ${short(listFile)})`);
  if (spec && !reels && rendered && rendered !== spec.cards.length) {
    errors.push(`${rendered} rendered card(s) but the spec has ${spec.cards.length} — re-render, the images are stale`);
  }
  if (!process.env.CROSSPOST_MEDIA_BASE_URL && !existsSync(listFile)) {
    errors.push('CROSSPOST_MEDIA_BASE_URL is unset — Meta fetches media from a public URL, so rendered files alone cannot be published');
  }

  // 3) caption
  const capPath = join(POSTS, `${slug}.insta.txt`);
  const fallback = join(POSTS, `${slug}.txt`);
  if (!existsSync(capPath) && !existsSync(fallback)) {
    errors.push(`no caption: ${short(capPath)}`);
  } else {
    const usingFallback = !existsSync(capPath);
    const raw = readFileSync(usingFallback ? fallback : capPath, 'utf8').trim();
    const caption = raw;
    if (usingFallback) warnings.push('no .insta.txt — falling back to the canonical body, which is usually too long for a caption');
    const r = validateCaption(caption, { canonicalUrl: canonicalLink(fallback) });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }

  return { slug, format, errors, warnings };
}

const targets = ALL
  ? [...new Set(readdirSync(dataPath('cards')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')))]
  : [one];

let failed = 0;
for (const slug of targets) {
  const r = checkSlug(slug, REELS);
  const status = r.errors.length ? 'FAIL' : r.warnings.length ? 'warn' : 'ok';
  console.log(`${status.padEnd(4)}  ${slug} (${r.format})`);
  for (const e of r.errors) console.log(`      ✗ ${e}`);
  for (const w of r.warnings) console.log(`      · ${w}`);
  if (r.errors.length) failed++;
}

if (failed) {
  console.error(`\n${failed} post(s) are not publishable. Nothing here is fixable after publishing.`);
  process.exit(1);
}
