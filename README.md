# crosspost

**Write once, publish everywhere.** Draft a single canonical post in your own brand voice, then
cross-post it to every channel you've configured — LinkedIn, Facebook, Threads, X, Remember,
Brunch, and Naver Blog — with per-channel body variants, unified stats, and edit/delete support.

A [Claude Code](https://claude.com/claude-code) plugin. You drive it with `/publish`; Claude
handles the drafting, the per-channel API/browser calls, and a merged stats report.

## Install

```
/plugin marketplace add hjsh200219/crosspost
/plugin install crosspost@crosspost
```

Then run `/crosspost:setup` and follow the per-channel steps.

## What it does

- **One source in → many posts out.** Give it a **YouTube URL** (captions are extracted), a
  **GitHub repo** (an intro post *with* original-source credit), or a **topic/draft**.
- **Your voice.** It reads your `voice.md` and writes in it — you own the tone, length, and rules.
- **Rich-source angles.** For a video or repo it first offers a few candidate angles as a table and
  lets you pick, instead of guessing one.
- **Auto-detected channels.** A channel runs only when its credentials are set. Unconfigured
  channels are skipped silently — you don't need all seven.
- **Per-channel variants.** Optional `<slug>.x.txt` / `<slug>.threads.txt` sibling files override
  the body for those channels; everything else uses the canonical file.
- **Unified stats.** `/publish --stat` reads every channel's ledger and renders one merged table,
  newest first.
- **Edit / delete.** Delete on all channels; edit-in-place on five (Threads and X do delete+repost).

## Channels

| Channel | Transport | API status | Notes |
|---------|-----------|-----------|-------|
| LinkedIn | Official Posts API | Official | `w_member_social` token |
| Facebook | Official Graph API | Official | Page access token |
| Threads | Official Graph API | Official | User token, ~60-day expiry |
| X (Twitter) | Official API v2 | Official | OAuth 1.0a; watch 429/402 |
| Remember | Private API | **Unofficial / experimental** | May break without notice |
| Brunch | Browser session (CDP) | No official API | Korean platform; one-time Kakao login |
| Naver Blog | Browser session (CDP) | No official API | Korean platform; one-time Naver login |

The four official-API channels and Remember need **no browser**. Brunch and Naver Blog drive a
shared local Chromium via CDP and need a one-time manual login that persists in a local profile.

## Quick start

1. `/plugin install crosspost@crosspost`
2. `/crosspost:setup` — creates `~/.crosspost`, copies the `.env` and `voice.md` templates, and
   walks you through credentials for the channels you want.
3. Edit `~/.crosspost/voice.md` to describe your brand voice.
4. `/publish https://youtu.be/…` — pick an angle, and it drafts and cross-posts to every
   configured channel.
5. `/publish --stat` — see engagement across channels in one table.

## Data layout

All your state lives **outside** the plugin install (plugin installs are cache copies replaced on
update). Everything is under `$CROSSPOST_HOME` (default `~/.crosspost`):

```
~/.crosspost/
├── .env                      # channel credentials (chmod 600)
├── voice.md                  # your brand voice guide
├── posts/                    # canonical post files + per-channel variants
├── ledgers/                  # published-<channel>.json (what was posted where)
└── browser-profile/          # persistent Chromium profile for Brunch / Naver
```

Set `CROSSPOST_HOME` to relocate it. Optional common vars: `CROSSPOST_CDP_PORT` (default 9224) and
`CANONICAL_BASE_URL` (prepended to trailer links back to your canonical post; leave empty to disable).

## FAQ

**A token stopped working.** Threads user tokens expire ~60 days (re-issue in the Threads token
generator). LinkedIn tokens expire too (re-auth in the LinkedIn developer portal). X returns 429
on rate limits and 402 when credits are exhausted — back off and retry later, don't hammer.

**Brunch/Naver ask me to log in.** Their sessions expire occasionally and cannot be re-logged in
automatically. Run `npm run browser` at the plugin root and log in by hand in the window; the
session persists in `browser-profile/`.

**Do I need the Korean channels?** No. Remember, Brunch, and Naver Blog are Korea-oriented and
fully optional. Configure only the channels you use — the rest are skipped.

**Where do my drafts and metrics live?** In `~/.crosspost/posts/` and `~/.crosspost/ledgers/`,
never inside the plugin directory.

## Disclaimer

- **Remember** uses an **unofficial, undocumented API**. It is experimental and may break at any
  time without notice.
- **Brunch and Naver Blog** are automated through a browser because they have no official write
  API. They depend on those sites' UI staying stable and can break when the sites change.
- **You are responsible for your own accounts** and for complying with each platform's Terms of
  Service and rate limits. Automated posting and scraping may be restricted on some platforms;
  use this tool accordingly and at your own risk.

## License

MIT — see [LICENSE](./LICENSE).
