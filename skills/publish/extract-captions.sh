#!/usr/bin/env bash
# Extract a YouTube video's title + caption transcript as clean plain text.
# Prefers manual subs (ko, then en), falls back to auto-generated.
# Usage: extract-captions.sh <youtube-url> [lang-priority="ko,en"]
# Prints:  TITLE: <title>\nURL: <url>\nFILE: <transcript path>
# Transcript written to a temp .txt (timestamps/markup stripped, de-duplicated).
set -euo pipefail

URL="${1:?usage: extract-captions.sh <youtube-url> [langs]}"
LANGS="${2:-ko,en}"
WORK="$(mktemp -d -t yt2li)"
cd "$WORK"

TITLE="$(yt-dlp --no-warnings --skip-download --print "%(title)s" "$URL" 2>/dev/null | head -1)"
[ -z "$TITLE" ] && TITLE="(untitled)"

# Try manual subs first, then auto subs. vtt format.
yt-dlp --no-warnings --skip-download \
  --write-subs --sub-langs "$LANGS" --sub-format vtt \
  -o "sub.%(ext)s" "$URL" >/dev/null 2>&1 || true

if ! ls sub*.vtt >/dev/null 2>&1; then
  yt-dlp --no-warnings --skip-download \
    --write-auto-subs --sub-langs "$LANGS" --sub-format vtt \
    -o "sub.%(ext)s" "$URL" >/dev/null 2>&1 || true
fi

VTT="$(ls -1 sub*.vtt 2>/dev/null | head -1 || true)"
if [ -z "$VTT" ]; then
  echo "ERROR: no captions found for $URL (tried langs: $LANGS)" >&2
  exit 4
fi

OUT="$WORK/transcript.txt"
# VTT -> plain text: drop header/timestamps/cue settings/inline tags, collapse, de-dup consecutive lines
awk '
  /^WEBVTT/ {next}
  /^NOTE/ {next}
  /-->/ {next}
  /^[0-9]+$/ {next}
  /^Kind:|^Language:/ {next}
  {
    gsub(/<[^>]*>/, "");          # inline <c> / timestamp tags
    gsub(/\r/, "");
    gsub(/^[[:space:]]+|[[:space:]]+$/, "");
    if ($0 == "") next;
    if ($0 == prev) next;          # drop immediate duplicates (auto-caption rolling)
    print; prev=$0;
  }
' "$VTT" > "$OUT"

echo "TITLE: $TITLE"
echo "URL: $URL"
echo "FILE: $OUT"
echo "CHARS: $(wc -m < "$OUT" | tr -d ' ')"
