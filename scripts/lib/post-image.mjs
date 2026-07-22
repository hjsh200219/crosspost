// Resolve a post file to a sibling cover image, so channels can auto-attach
// it without an explicit --image flag. Mirrors how canonical-link.mjs
// auto-resolves a canonical URL: channels attach the image automatically
// when a sibling image file exists, so the publish flow never has to pass
// --image by hand.
//
// Contract: given `posts/2026-07-07_foo.txt`, look for a sibling
// `posts/2026-07-07_foo.<ext>` (png/jpg/jpeg/webp), same basename as the
// post file. If none exists, returns null and the caller posts text-only.
// Auto-attach must always be BEST-EFFORT: an image that fails to
// upload/transcode must never sink a text post that used to succeed.

import { existsSync } from "node:fs";
import path from "node:path";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp"];

/**
 * Resolve a post file's sibling cover image. Returns { src, imageAbs, imageUrl }
 * or null when no sibling image exists. imageUrl is always null here — this
 * generic tool has no public image host, so URL-only channels (e.g. Threads)
 * must upload the image themselves or fall back to text-only.
 */
export function resolveImage(file) {
  const dir = path.dirname(String(file));
  const stem = path.basename(String(file)).replace(/\.txt$/, "");
  for (const ext of IMAGE_EXTS) {
    const name = `${stem}.${ext}`;
    const abs = path.join(dir, name);
    if (existsSync(abs)) {
      return { src: name, imageAbs: abs, imageUrl: null };
    }
  }
  return null;
}
