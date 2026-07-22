#!/usr/bin/env bash
# Launch a persistent Chromium/Chrome with remote debugging, shared by all
# crosspost channels that need a real browser session (Brunch, Naver Blog).
#   1) run this script (npm run browser)
#   2) in the opened window, log into Kakao/Brunch, Naver, Facebook, etc.
#      once — sessions persist in this profile
#   3) leave it running; channel scripts connect over CDP on the same port
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_HOME="${CROSSPOST_HOME:-$HOME/.crosspost}"
PORT="${CROSSPOST_CDP_PORT:-9224}"
PROFILE="$DATA_HOME/browser-profile"
mkdir -p "$PROFILE"

# Idempotent: a CDP-enabled browser answers /json/version. If one's already
# up on this port, don't launch a second instance on top of it.
if curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "already running (CDP :$PORT)"
  exit 0
fi

find_chrome() {
  local candidates=(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
    "/usr/bin/google-chrome-stable"
    "/usr/bin/google-chrome"
    "/usr/bin/chromium-browser"
    "/usr/bin/chromium"
    "/snap/bin/chromium"
  )
  local c
  for c in "${candidates[@]}"; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  # Fall back to Playwright's bundled Chromium (shared global cache), if installed
  local pw
  pw="$(find "$HOME/Library/Caches/ms-playwright" "$HOME/.cache/ms-playwright" \
        -maxdepth 7 -type f -perm -u+x \
        \( -name 'Google Chrome for Testing' -o -name 'chrome' \) \
        2>/dev/null | sort | tail -1)"
  [ -n "$pw" ] && { echo "$pw"; return 0; }
  return 1
}

CHROME="$(find_chrome || true)"
if [ -z "$CHROME" ]; then
  echo "No Chrome/Chromium found. Install one of:" >&2
  echo "  - Google Chrome or Chromium (system install)" >&2
  echo "  - Playwright's bundled Chromium: (cd \"$DIR/../..\" && npx playwright install chromium)" >&2
  exit 1
fi

echo "Launching browser (CDP :$PORT, profile: $PROFILE)"
exec "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check \
  "about:blank"
