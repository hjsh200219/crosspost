#!/usr/bin/env node
/**
 * Assemble reel frames into an mp4 slideshow.
 *
 *   node gen-cards.mjs <slug> && node gen-reel.mjs <slug>
 *   node gen-reel.mjs <slug> --audio track.m4a     # optional soundtrack (licensing is on you)
 *
 * Reads $CROSSPOST_HOME/build/<slug>/reel-NN.jpg and writes
 * $CROSSPOST_HOME/media/<slug>/reel.mp4 — the media directory is the one you publish, so the
 * intermediate frames stay out of it.
 *
 * Cut length is derived from how much text a frame carries rather than fixed: a dense frame
 * that flips at the same speed as a three-word one is simply unread. If most frames hit the
 * ceiling, the script says so — the fix is shorter copy, not longer cuts, because a reel has
 * no re-read.
 *
 * ffmpeg is required and intentionally not bundled. If it is missing this explains how to get
 * it instead of failing with a spawn error.
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadEnv, dataPath, home } from '../lib/env.mjs';

loadEnv();

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('--'));
if (!slug) { console.error('usage: node gen-reel.mjs <slug> [--audio <file>] [--secs N]'); process.exit(1); }
const audio = args.includes('--audio') ? args[args.indexOf('--audio') + 1] : null;
const fixedSecs = args.includes('--secs') ? Number(args[args.indexOf('--secs') + 1]) : null;

if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) {
  console.error('ffmpeg not found. Install it first (macOS: brew install ffmpeg · Debian/Ubuntu: apt install ffmpeg).');
  process.exit(1);
}

const BUILD = dataPath(`build/${slug}`);
const OUT_DIR = dataPath(`media/${slug}`);
const OUT = join(OUT_DIR, 'reel.mp4');

const frames = existsSync(BUILD) ? readdirSync(BUILD).filter((f) => /^reel-\d+\.jpg$/.test(f)).sort() : [];
if (!frames.length) {
  console.error(`no frames in ${BUILD.replace(home(), '$CROSSPOST_HOME')} — run: node gen-cards.mjs ${slug}`);
  process.exit(1);
}

// Cut length from text volume. Reading speed, not aesthetics, sets the floor.
const MIN = 1.8, MAX = 6.0;
let spec = { cards: [] };
let specOk = false;
try { spec = JSON.parse(readFileSync(dataPath(`cards/${slug}.json`), 'utf8')); specOk = true; } catch { /* fall back to a flat cadence */ }
// spec이 있는데 프레임 수가 다르면 stale 프레임이 섞인 것 — 그대로 concat하면
// 옛 콘텐츠가 reel.mp4에 영구히 박힌다(IG는 발행 후 미디어 교체 불가).
if (specOk && Array.isArray(spec.cards) && spec.cards.length && spec.cards.length !== frames.length) {
  console.error(`frame count (${frames.length}) != spec cards (${spec.cards.length}) — stale frames in ${BUILD.replace(home(), '$CROSSPOST_HOME')}; re-run: node gen-cards.mjs ${slug}`);
  process.exit(1);
}
const charsOf = (card) => JSON.stringify(card || {}).replace(/[^\p{L}\p{N}]/gu, '').length;
const durations = frames.map((_, i) => {
  if (fixedSecs) return fixedSecs;
  const n = charsOf(spec.cards?.[i]);
  return Math.min(MAX, Math.max(MIN, 1.8 + n / 16));
});
const capped = durations.filter((d) => d >= MAX).length;

const listPath = join(BUILD, 'frames.txt');
const lines = frames.map((f, i) => `file '${join(BUILD, f)}'\nduration ${durations[i].toFixed(2)}`);
lines.push(`file '${join(BUILD, frames[frames.length - 1])}'`); // concat demuxer needs the last frame twice
writeFileSync(listPath, lines.join('\n') + '\n');

mkdirSync(OUT_DIR, { recursive: true });
const ff = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath];
if (audio) ff.push('-i', audio, '-shortest');
else ff.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100', '-shortest');
ff.push(
  '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
  '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
  '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', OUT,
);
execFileSync('ffmpeg', ff, { stdio: ['ignore', 'ignore', 'inherit'] });

const total = durations.reduce((a, b) => a + b, 0);
console.log(`${OUT.replace(home(), '$CROSSPOST_HOME')} — ${frames.length} cuts, ${total.toFixed(1)}s`);
// A silent audio track is always muxed in: some clients treat a video with no audio stream as broken.
if (capped > frames.length / 2) {
  console.error(`\n${capped}/${frames.length} cuts hit the ${MAX}s ceiling — the script is too long for a reel.`);
  console.error('Shorten the card text rather than lengthening the cuts; a reel gives no second read.');
}
