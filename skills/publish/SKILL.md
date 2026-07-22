---
name: publish
description: >-
  Turn one source (a YouTube URL, a GitHub repo, or a topic/draft) into a single
  canonical post in your own brand voice and cross-post it to every configured
  channel — LinkedIn, Facebook, Threads, X, Remember, Brunch, Naver Blog. Skips
  channels you have not set up. With no arguments (or --stat) it reports engagement
  stats across channels instead. Triggers — "publish", "cross-post", "post this
  everywhere", "post to LinkedIn/Threads/X", a YouTube or GitHub URL with "post
  this"/"share this", "발행", "크로스포스트", "링크드인/스레드 발행", "이 영상/레포 올려".
argument-hint: "<youtube-url | github-url | topic | --stat> [angle / instructions]"
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, WebFetch
---

# /publish — one canonical post → every configured channel

Take a source, write it once in the user's brand voice, and publish it to each
channel that has credentials. Channels are **auto-detected**: a channel runs only
when its environment variables are present in `$CROSSPOST_HOME/.env`
(default `~/.crosspost/.env`). Unconfigured channels are skipped silently.

Paths below use two roots:
- `${CLAUDE_PLUGIN_ROOT}` — where this plugin is installed (the channel scripts live under `scripts/<channel>/`).
- `$CROSSPOST_HOME` — the user's data home (default `~/.crosspost`): `.env`, `voice.md`, `posts/`, `ledgers/`, `browser-profile/`.

---

## 0. Read the voice guide first

Before drafting anything, read **`$CROSSPOST_HOME/voice.md`** and write in that voice
(identity, tone, sentence rhythm, length per channel, hashtag/emoji policy, hard rules).

If the file does not exist, tell the user:

> No voice guide found. Create one from the template:
> `cp ${CLAUDE_PLUGIN_ROOT}/config/voice.example.md $CROSSPOST_HOME/voice.md` and edit it.

Then either wait for it, or proceed with neutral, plain prose and note that the voice
guide is missing.

---

## 1. Input routing (decide first)

| Input | Branch |
|-------|--------|
| **no arguments**, or `--stat` / "stats" / "성과" | **D. Stats** — report engagement across channels; do not draft or publish |
| `youtube.com/…` · `youtu.be/…` | **A. YouTube** — extract captions, then draft |
| `github.com/<owner>/<repo>` | **B. GitHub** — tool/project intro post **with original-source credit** |
| any other topic / draft text | **C. Topic** — draft directly |

An optional trailing angle/instruction ("as a case study", "shorter", "for beginners")
applies to every drafting branch.

---

## 2. Rich sources: offer angles before drafting (A · B)

A YouTube video or a GitHub repo yields several possible post angles. **Do not pick one
silently.** After you understand the source (captions for A, repo for B):

1. Summarize the source briefly, **content-first** — no meta-framing ("this video is about…").
2. Present **2–4 candidate angles as a table**: columns `# | Angle | One-line hook | Appeal`.
   Put a recommended angle first (mark it `★`) with one line on why.
   Render a real Markdown table (pipes), not a fenced code block.
3. Wait for the user's pick. Do **not** use a multiple-choice prompt widget — accept a plain
   text reply (`1`, `1,3`, "the recommended one", "all", or a fresh angle of their own).

Skip this gate when the user already gave a concrete angle, said "just post it / you pick",
or the branch is **C** (topic — the angle is already fixed) or **D** (stats).

After a pick, draft (one post per chosen angle) and continue to the publish flow.

### A. YouTube — extract captions

```bash
bash ${CLAUDE_PLUGIN_ROOT}/skills/publish/extract-captions.sh "<URL>" "ko,en"
```

Read the path printed after `FILE:` to get the transcript; keep the `TITLE:`. If it exits
with an error (no captions), tell the user and ask whether to summarize manually. Draft from
the **actual content discussed**, not a description of the video.

### B. GitHub — intro post with source credit

```bash
gh repo view <owner>/<repo>     # description, README head, language, stars
```

If you need more, fetch the raw README with WebFetch:
`https://raw.githubusercontent.com/<owner>/<repo>/main/README.md` (try `master` if `main` 404s).

Attribution is mandatory:
- **Someone else's repo → never claim you built it.** Write in a "found it / tried it / here's
  what it does" tone, name the author (owner), and end with one credit line:
  `Source (<license>): github.com/<owner>/<repo>`.
- Only claim authorship if it is genuinely the user's own repo.
- State only facts that are in the README. Do not exaggerate features or invent capabilities.

### C. Topic / draft

Draft one post on the given topic in the user's voice.

**Source (mandatory when the post makes factual claims).** If the post states any specific
factual claim — a company announcement, an event, a statistic, a third-party quote, news —
you must cite the source. Pure opinion, perspective, or the user's own build log needs none.
When a factual claim is present, add one line at the end of the body of the canonical `.txt`
(and the `.en.txt` sibling), before the link trailer:
`Source: <disclosing party> & reporting (<outlet>, <YYYY-MM-DD>)`. The `.x.txt` teaser may omit
it when the character budget is tight (the canonical link stands in). This applies to branch **A**
(YouTube) too whenever the video rests on a factual claim, not just topic drafts.

---

## 3. Writing the post

- **First line is the post.** On feed channels the first line is the headline and the feed
  preview — it must make the reader stop. Open with the post's **conclusion**, compressed into
  one assertive line — not the setup, the source, or a quote.
- **No meta-framing.** Do not open with "This video/repo covers…". Lead with the claim.
- Keep the first line **identical** across the canonical file and every channel variant; only
  the paragraphs below diverge.
- Defer tone, length, hashtag, and emoji specifics to `voice.md`. Break paragraphs with blank lines.

---

## 4. Canonical file + per-channel variants

Save the post as a plain-text file (body exactly as it should publish, no metadata header):

```
$CROSSPOST_HOME/posts/<slug>.txt          # canonical — every channel reads this by default
```

Optional sibling files override the body **per channel** (same slug, different infix). The
scripts swap the body automatically; the slug, canonical link, image, and ledger always
resolve from the canonical file:

| Sibling file | Used by | Priority |
|--------------|---------|----------|
| `<slug>.x.txt` | X | `.x.txt` → `.threads.txt` → canonical |
| `<slug>.threads.txt` | Threads | `.threads.txt` → canonical |
| `<slug>.en.txt` | long-form channels (LinkedIn, Facebook, Remember, Naver) | appended after the canonical body as an English translation block |

Write a variant only when a channel's format warrants it (e.g. a short X teaser, a casual
Threads version). If absent, the channel uses the canonical body. A `<slug>.en.txt` sibling,
when present, is merged below the canonical body (divider + English text) rather than
replacing it — delete the sibling if you don't want the bilingual layout.

---

## 5. Publish flow

Publish the same canonical file to each **configured** channel. Detect configuration from the
env vars present in `$CROSSPOST_HOME/.env`:

| Channel | Configured when set | Transport |
|---------|--------------------|-----------|
| LinkedIn | `LINKEDIN_ACCESS_TOKEN` (+ `LINKEDIN_PERSON_URN`) | official API — no browser |
| Facebook | `FACEBOOK_PAGE_ACCESS_TOKEN` (+ `FACEBOOK_PAGE_ID`) | official Graph API — no browser |
| Threads | `THREADS_ACCESS_TOKEN` (+ `THREADS_USER_ID`) | official Graph API — no browser |
| X | `X_API_KEY` / `X_API_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_SECRET` | official API v2 — no browser |
| Remember | `REMEMBER_TOKEN` | unofficial API (experimental) — no browser |
| Brunch | `BRUNCH_COOKIE` | browser session (CDP) |
| Naver Blog | `NAVER_BLOG_ID` | browser session (CDP) |

For each configured channel:

```bash
cd ${CLAUDE_PLUGIN_ROOT}/scripts/<channel> && node post-api.mjs --skip-done "$CROSSPOST_HOME/posts/<slug>.txt"
```

`--skip-done` prevents duplicate posts (each channel keeps its own ledger). Pass the
**canonical** path even when variants exist — the script picks the right body.

- **API channels** (linkedin, facebook, threads, x, remember) need no browser.
- **Browser channels** (brunch, naver-blog) need the shared CDP browser running:
  ```bash
  cd ${CLAUDE_PLUGIN_ROOT} && npm run browser
  ```
  This launches Chromium with a persistent profile on `CROSSPOST_CDP_PORT` (default 9224).
  The **first time**, a human must log in once (Kakao for Brunch, Naver for Naver Blog) in that
  window; the session persists in `browser-profile/`. Automated re-login is not possible for these.
- If a channel is unconfigured, skip it silently. If a configured channel fails, the others still
  count — retry only the failed one. If the user says "without Threads/Brunch/…", skip that channel.
- **Canonical trailer link:** if `CANONICAL_BASE_URL` is set, channels append a link back to your
  canonical post (`<CANONICAL_BASE_URL>/<slug>`). Leave it empty to disable trailer links.

---

## 6. Stats (branch D — no args or `--stat`)

Read each channel's ledger and query current metrics. **Two groups, run differently:**

- **Browserless group — safe to run in parallel** (`&` background): `remember`, `threads`,
  `facebook` (engagement via `stats.mjs`), `x`. Each is a direct API call.
- **CDP group — shares ONE browser, run strictly sequentially, one at a time**: `linkedin`
  (`stats-fast.mjs`), `brunch` (`stats.mjs`), `naver` (`stats.mjs`), `facebook` reach
  (`fb-reach.mjs`). These do per-item in-page fetches on the shared CDP browser; running two at
  once makes the fetches race and drop results (null/missing metrics). Never `&` these together.

Recommended pattern: fire the four browserless jobs in the background, then run the CDP jobs
one after another in the foreground, then `wait`.

```bash
# browserless (parallel)
( cd ${CLAUDE_PLUGIN_ROOT}/scripts/remember && node stats.mjs ) &
( cd ${CLAUDE_PLUGIN_ROOT}/scripts/threads  && node stats.mjs ) &
( cd ${CLAUDE_PLUGIN_ROOT}/scripts/facebook && node stats.mjs ) &
( cd ${CLAUDE_PLUGIN_ROOT}/scripts/x        && node stats.mjs ) &
# CDP (sequential — one browser)
cd ${CLAUDE_PLUGIN_ROOT}/scripts/linkedin && node stats-fast.mjs
cd ${CLAUDE_PLUGIN_ROOT}/scripts/brunch   && node stats.mjs
cd ${CLAUDE_PLUGIN_ROOT}/scripts/naver-blog && node stats.mjs
cd ${CLAUDE_PLUGIN_ROOT}/scripts/facebook && node fb-reach.mjs
wait
```

Render **one merged table**, newest first by the original publish date, with a totals row.
Suggested columns: `Title | Date | Reach/Views | Likes | Comments`. Re-order any channel whose
CLI prints oldest-first before rendering. Do not paste raw CLI lines — rebuild them as a table.
In a terminal use a real Markdown table (pipes); only for chat surfaces that don't render
Markdown tables, fall back to monospace.

Platform quirks to note under the table:
- **Naver views finalize daily**, so a post published today shows 0 until the next day.
- **Threads comment counts** can be inflated by chain-continuation chunks counted as replies —
  not real external comments.
- **Facebook reach/impressions are unavailable via the Graph API** (metrics deprecated); reach
  comes from the CDP `fb-reach.mjs` page scrape, engagement from `stats.mjs`.

---

## 7. Edit / delete

Delete is supported on all channels. Edit-in-place on five; on Threads and X, "edit" means
delete + repost.

| Channel | Delete | Edit | Command (in that channel's script dir) |
|---------|:---:|:---:|----------------------------------------|
| LinkedIn | ✓ | ✓ | `node post-api.mjs --delete <id>` / `--edit <id> <file>` |
| Facebook | ✓ | ✓ | `node post-api.mjs --delete <id>` / `--edit <id> <file>` |
| Remember | ✓ | ✓ | `node post-api.mjs --delete <id>` / `--edit <id> <file>` |
| Brunch | ✓ | ✓ | `node post-api.mjs --delete <id>` / `--edit <id> <file>` |
| Naver Blog | ✓ | ✓ | `node post-api.mjs --delete <id>` / `--edit <id> <slug>` |
| Threads | ✓ | ✗ | `node post-api.mjs --delete <id>` (no edit API → delete + repost) |
| X | ✓ | ✗ | `node post-api.mjs --delete <id>` (edit = delete + repost) |

If an edit is unsupported or fails, the safe fallback on any channel is delete + repost.

---

## 8. Ledgers

Each channel records what it publishes to `$CROSSPOST_HOME/ledgers/published-<channel>.json`
automatically. `--skip-done` and the stats branch both read these ledgers. If a ledger entry
points at a deleted post, stats will show it as a lookup failure — prune those entries.

---

## 9. Safety notes

- **X rate limits.** On HTTP 429 (rate limit) or 402 (credit exhausted), **stop** — do not hammer
  retries. Wait and retry later.
- **Threads token expiry (~60 days).** A 401 from the Threads API means the token expired;
  re-issue it in the Threads dashboard token generator and update `THREADS_ACCESS_TOKEN`.
- **Threads images need a public URL.** Threads accepts only a public HTTPS `image_url` (no binary
  upload), and this plugin ships no public image host — so `lib/post-image.mjs` returns
  `imageUrl=null` and an image-bearing post attaches **no image** on Threads by default. Workaround
  when **Facebook is configured** and the post has an image: publish to Facebook first, then read
  that photo post's public CDN URL and hand it to Threads via `--image-url`:
  ```bash
  curl "https://graph.facebook.com/v21.0/<fbPostId>?fields=full_picture&access_token=<FACEBOOK_PAGE_ACCESS_TOKEN>"
  cd ${CLAUDE_PLUGIN_ROOT}/scripts/threads && node post-api.mjs --image-url "<full_picture-url>" "$CROSSPOST_HOME/posts/<slug>.txt"
  ```
  If Facebook is not configured, Threads publishes **text-only** unless you pass an explicit `--image-url`.
- **Remember is an unofficial API.** It is experimental and may break without notice. Treat any
  failure as non-fatal to the other channels.
- **Brunch / Naver sessions expire occasionally.** When a browser channel reports a login/session
  error, re-login manually in the CDP browser window (`npm run browser`) and retry.
