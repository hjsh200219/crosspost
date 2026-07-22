// Resolve a post file to its canonical URL, if a base URL is configured.
// Shared by the channel publishers so cross-posts can point back to the
// canonical article.
//
// Contract: the canonical slug is the post file's basename minus an optional
// `YYYY-MM-DD_` date prefix, an optional per-channel variant infix
// (`.en`/`.x`/`.threads`), and the `.txt` extension. Date-prefixed names are
// recommended (they sort naturally) but not required. If CANONICAL_BASE_URL
// is unset, the caller skips trailer links (no site to link back to, no 404
// risk).

import path from "node:path";

export function slugFromFile(file) {
  const m = path
    .basename(String(file))
    .match(/^(?:\d{4}-\d{2}-\d{2}_)?(.+?)(?:\.(?:en|x|threads))?\.txt$/);
  return m ? m[1] : null;
}

/** Canonical URL for a post file, or null if CANONICAL_BASE_URL is unset or no slug. */
export function canonicalLink(file) {
  const base = process.env.CANONICAL_BASE_URL;
  if (!base) return null;
  const slug = slugFromFile(file);
  if (!slug) return null;
  return `${base.replace(/\/$/, "")}/${slug}`;
}

/**
 * User-facing label channels prefix before a canonical link in their
 * trailer/comment (e.g. `${linkText()}: ${canonicalLink(file)}`). Centralized
 * here so channels don't each hardcode their own copy; override with
 * CROSSPOST_LINK_TEXT.
 */
export function linkText() {
  return process.env.CROSSPOST_LINK_TEXT || "Read the full article";
}
