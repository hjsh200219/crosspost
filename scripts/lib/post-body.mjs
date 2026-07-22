// Assemble a post body from a Korean post file, appending its English
// sibling (`<name>.en.txt`) below a divider when present. Channels opt into
// bilingual bodies by importing this; others read `posts/<name>.txt`
// directly and stay Korean-only.
//
// Contract: given `posts/2026-07-07_foo.txt`, look for `posts/2026-07-07_foo.en.txt`.
// If it exists and is non-empty, return `<ko>\n\n———\n\n<en>`, else just `<ko>`.
// The divider uses em dashes (U+2014), which survive typical post-api `--edit`
// escaping (not in most special-char sets).

import { readFileSync, existsSync } from "node:fs";

export const LANG_DIVIDER = "———";

/** English sibling path for a Korean post file, or null if the input is already an `.en.txt`. */
export function enSiblingPath(file) {
  const f = String(file);
  if (f.endsWith(".en.txt")) return null; // already the English file — no double-derivation
  if (!f.endsWith(".txt")) return null;
  return f.replace(/\.txt$/, ".en.txt");
}

/**
 * Read a post file's publishable body: Korean body + (if present) English
 * translation below a divider. Falls back to the Korean body alone when no
 * `.en.txt` sibling exists.
 */
export function readPostBody(file) {
  const ko = readFileSync(file, "utf8").trim();
  const enPath = enSiblingPath(file);
  if (!enPath || !existsSync(enPath)) return ko;
  const en = readFileSync(enPath, "utf8").trim();
  if (!en) return ko;
  return `${ko}\n\n${LANG_DIVIDER}\n\n${en}`;
}
