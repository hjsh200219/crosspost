/**
 * Is an mp4 finished — the single source of truth.
 *
 * Do NOT judge this with `existsSync`. When ffmpeg dies mid-render it leaves a file with no
 * moov atom behind, and that file "exists": the generator then skips it forever while the
 * publish gate blocks on it forever — a silent deadlock that nothing reports. A reel that was
 * never playable sat undetected exactly this way until an unrelated batch run stumbled on it.
 *
 * ffprobe is part of the ffmpeg install that gen-reel.mjs already requires, so this adds no
 * new dependency. If ffprobe is missing or fails, the answer is "not finished" — letting a
 * broken file through would restore the very deadlock this exists to prevent.
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** Duration in seconds, or `null` when it cannot be read — distinct from a real `0`. */
export function durationOf(path) {
  if (!existsSync(path)) return null;
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** A playable mp4 — ffprobe reports a positive duration. */
export function playable(path) {
  return (durationOf(path) ?? 0) > 0;
}
