---
description: Walk the user through crosspost setup — data home, voice guide, and per-channel credentials. Only guides the channels that are not configured yet.
---

# /crosspost:setup

You are guiding the user through first-time setup of the **crosspost** plugin. Work through the
steps below **in order**. Be concise. At each channel, first check whether it is already
configured and **skip channels that are done** — only guide the missing ones.

Two roots you will refer to:
- `${CLAUDE_PLUGIN_ROOT}` — the plugin install directory (channel scripts live under `scripts/<channel>/`).
- `$CROSSPOST_HOME` — the user's data home, default `~/.crosspost`.

---

## Step 1 — Create the data home and copy templates

```bash
export CROSSPOST_HOME="${CROSSPOST_HOME:-$HOME/.crosspost}"
mkdir -p "$CROSSPOST_HOME"
[ -f "$CROSSPOST_HOME/.env" ]      || { cp "${CLAUDE_PLUGIN_ROOT}/config/.env.example" "$CROSSPOST_HOME/.env" && chmod 600 "$CROSSPOST_HOME/.env"; }
[ -f "$CROSSPOST_HOME/voice.md" ]  || cp "${CLAUDE_PLUGIN_ROOT}/config/voice.example.md" "$CROSSPOST_HOME/voice.md"
```

Tell the user to edit **`$CROSSPOST_HOME/voice.md`** to describe their own brand voice — the
publish skill reads it before drafting every post.

## Step 2 — See what is already configured

Read `$CROSSPOST_HOME/.env` and note which channel variables already have values. A channel is
**on** when its key variable is set:

| Channel | Key variable |
|---------|--------------|
| LinkedIn | `LINKEDIN_ACCESS_TOKEN` |
| Facebook | `FACEBOOK_PAGE_ACCESS_TOKEN` |
| Threads | `THREADS_ACCESS_TOKEN` |
| X | `X_API_KEY` |
| Remember | `REMEMBER_TOKEN` |
| Brunch | `BRUNCH_COOKIE` |
| Naver Blog | `NAVER_BLOG_ID` |
| Instagram | `IG_USER_ID` + `IG_ACCESS_TOKEN` |

**Only walk the user through the channels that are still empty.** You do not need every channel —
crosspost publishes to whichever are configured and silently skips the rest. Ask the user which
of the missing channels they want to add now, and guide only those.

---

## Step 3 — Per-channel credentials (guide only the missing ones)

### LinkedIn (official Posts API)
1. Create an app at https://developer.linkedin.com and request the **`w_member_social`** scope.
2. Generate a member access token and put it in `LINKEDIN_ACCESS_TOKEN`.
3. Set `LINKEDIN_PERSON_URN` to `urn:li:person:<your-id>`.
   Tokens expire; re-auth from the LinkedIn developer portal when you see "access token expired".

### Facebook Page (Graph API)
1. Create an app at https://developers.facebook.com and add a Page.
2. Get a **User** token with Page management permissions; put it in `FACEBOOK_USER_TOKEN`.
3. Exchange it for a long-lived **Page** token with the helper, then copy the values it prints:
   ```bash
   cd ${CLAUDE_PLUGIN_ROOT}/scripts/facebook && node get-page-token.mjs
   ```
   Set `FACEBOOK_PAGE_ID` and `FACEBOOK_PAGE_ACCESS_TOKEN`. Page tokens are typically long-lived.

### Threads (official Graph API)
1. In your Meta app at https://developers.facebook.com, add the **Threads** use case.
2. Use the token generator to issue a user token → `THREADS_ACCESS_TOKEN`.
3. Set `THREADS_USER_ID` to your Threads user id.
   User tokens expire in ~60 days; re-issue when the API returns 401.

### X / Twitter (official API v2, OAuth 1.0a user context)
1. Create an app at https://developer.x.com.
2. Under Keys & Tokens, create API keys and access tokens with **write** permission.
3. Set `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`.
   Watch for 429 (rate limit) and 402 (credit exhausted) — back off, don't retry hard.

### Remember (unofficial — experimental)
1. Log in to your Remember Connect account in a browser.
2. Capture the bearer/session token from a logged-in request and put it in `REMEMBER_TOKEN`.
   **This is an unofficial private API** — it may change or break at any time. Optional; enable
   at your own risk.

### Brunch (browser session — Korean platform, no official API)
1. Launch the shared browser and log in once with Kakao:
   ```bash
   cd ${CLAUDE_PLUGIN_ROOT} && npm run browser
   ```
   Log into Brunch (via Kakao) in that window. The session persists in
   `$CROSSPOST_HOME/browser-profile/`.
2. Set `BRUNCH_COOKIE` if your setup captured a session cookie; otherwise the persistent profile
   login is what the scripts use. Automated re-login is not possible — re-login by hand when the
   session expires.

### Naver Blog (browser session — no official write API)
1. In the same shared browser (`npm run browser`), log into Naver once.
2. Set `NAVER_BLOG_ID` to your blog id (the part after `blog.naver.com/`).
   Naver blocks automated login by policy — re-login manually when the session expires.

### Instagram (official Graph API, media required)
1. In your Meta app, add the **Instagram** use case and connect a Business or Creator account.
2. Set `IG_USER_ID` and a long-lived `IG_ACCESS_TOKEN`.
3. Publish generated cards or reels at a publicly reachable HTTPS location and set
   `CROSSPOST_MEDIA_BASE_URL` to that base URL. Meta fetches media from this URL; local files
   cannot be uploaded directly through the publishing API.

---

## Step 4 — Install dependencies

```bash
cd ${CLAUDE_PLUGIN_ROOT} && npm install
```

This installs Playwright (used by the browser channels). API-only setups still need it for the
shared library.

## Step 5 — Smoke test

Suggest a low-risk check before real posting:
- Draft a throwaway post to a file, e.g. `$CROSSPOST_HOME/posts/hello-crosspost.txt`.
- Run **stats** (`/publish --stat`) — it should read cleanly even with empty ledgers.
- Optionally publish the throwaway to a single configured channel, confirm it lands, then delete
  it with that channel's `node post-api.mjs --delete <id>`.

When finished, tell the user which channels are now configured and that `/publish` will
cross-post to exactly those.
