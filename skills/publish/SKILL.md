---
name: publish
description: >-
  Turn one source (a YouTube URL, a GitHub repo, or a topic/draft) into a single
  canonical post in your own brand voice and cross-post it to every configured
  channel — LinkedIn, Facebook, Threads, X, Remember, Brunch, Naver Blog, Instagram. Skips
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
| `<slug>.tags` | Naver Blog | comma- or newline-separated tags; `--tags "a,b,c"` overrides |

Write a variant only when a channel's format warrants it (e.g. a short X teaser, a casual
Threads version). If absent, the channel uses the canonical body. A `<slug>.en.txt` sibling,
when present, is merged below the canonical body (divider + English text) rather than
replacing it — delete the sibling if you don't want the bilingual layout.

**Naver tags.** Naver Blog is the only channel with a tag field. Put 5–10 search terms in
`<slug>.tags` (or pass `--tags "a,b,c"`); the publisher enters the first 10. Two silent
failure modes are handled for you, but they explain why tags come out looking "joined":

- **A space is a separator.** `AI 법률 상담` would be stored as three tags and the keywords
  after it get dropped — so spaces are stripped and it becomes `AI법률상담`.
- **A special character is rejected and takes the tags after it with it.** Entering `yt-dlp`
  silently swallowed the following tag — so only Hangul and alphanumerics survive.

Joined-up forms are also what people actually search on Naver. The publish log prints
`tags: N entered → N committed`; a `*** MISMATCH ***` there means the editor dropped some.

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
| Brunch | `BRUNCH_COOKIE` set, **or** a logged-in `$CROSSPOST_HOME/browser-profile/` directory (Kakao login via `npm run browser`) | browser session (CDP) |
| Naver Blog | `NAVER_BLOG_ID` | session cookie — no browser (`--ui` falls back to the editor) |
| Instagram | `IG_USER_ID` + `IG_ACCESS_TOKEN` (+ `CROSSPOST_MEDIA_BASE_URL`) | official Graph API — no browser, but **images are mandatory** |

For each configured channel:

```bash
cd ${CLAUDE_PLUGIN_ROOT}/scripts/<channel> && node post-api.mjs --skip-done "$CROSSPOST_HOME/posts/<slug>.txt"
```

### Instagram is not a text channel

Every other channel takes the post body. Instagram takes **images**, and its API fetches them
from a public URL rather than accepting an upload — so it needs two extra steps and it fails
loudly instead of falling back to text.

1. **Write a card spec** to `$CROSSPOST_HOME/cards/<slug>.json`. You write this, not a
   sub-tool. Aim for 4–8 cards; card 1 is a cover and is the only card most people see:

   ```json
   { "format": "carousel", "subject": "<short label for the footer>",
     "cards": [
       { "type": "cover",     "eyebrow": "…", "headline": "…", "sub": "…", "invert": true },
       { "type": "stat",      "value": "3.4s", "label": "…", "note": "…" },
       { "type": "body",      "heading": "…", "items": ["…", "…"] },
       { "type": "checklist", "heading": "…", "items": ["…"] },
       { "type": "quote",     "quote": "…", "attribution": "…" } ] }
   ```

   Keep every line inside the caps in `scripts/instagram/card-rules.mjs` — the renderer rejects
   the spec otherwise, and it also fails when text overflows its box at render time.

2. **Write the caption** to `$CROSSPOST_HOME/posts/<slug>.insta.txt`: 600–850 characters, the
   first line matching the canonical post's opening line, and **the canonical URL spelled out**.
   Links are not clickable on Instagram, but that address is the only route from the post to the
   full article. The feed truncates near 125 characters, so front-load it.

3. **Render, gate, publish:**

   ```bash
   cd ${CLAUDE_PLUGIN_ROOT}/scripts/instagram
   node gen-cards.mjs <slug>                  # or: --reels && node gen-reel.mjs <slug>
   # publish $CROSSPOST_HOME/media/<slug>/ to the user's public host
   node check-cards.mjs <slug>
   node post-api.mjs <slug> --dry-run         # containers only — proves Meta can fetch the URLs
   node post-api.mjs <slug> --skip-done
   ```

**Nothing here is fixable after publishing.** Media cannot be replaced, and a caption edit is
accepted by the API and then frequently ignored. Treat `check-cards.mjs` and `--dry-run` as the
real gate, and look at the rendered images before publishing.

Carousel or reel? Use a **carousel** when the content rewards stopping — code, a comparison, a
checklist. Use a **reel** when the claim compresses to one sentence and the cards carry numbers
or contrast; a reel gets no second read.

`--skip-done` prevents duplicate posts (each channel keeps its own ledger). Pass the
**canonical** path even when variants exist — the script picks the right body.

- **API channels** (linkedin, facebook, threads, x, remember) need no browser.
- **Naver Blog also needs no browser to publish** (2026-07-27): the SmartEditor endpoints answer a
  cookie'd request, so a post goes out in ~3s instead of a 60~90s editor drive. The browser is only
  used to capture `NAVER_COOKIE` the first time and to re-capture it when it expires — plus
  `--edit`/`--delete`, which still drive the editor.
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

- **Browserless group — safe to run in parallel** (`&` background): `linkedin`
  (`stats-fast.mjs`), `naver` (`stats.mjs`), `remember`, `threads`, `facebook` engagement
  (`stats.mjs`), `x`. LinkedIn and Naver joined this group on 2026-07-27 — the LinkedIn
  analytics page is server-rendered and Naver's cross-origin wall is CORS, which only exists in
  a browser. Both now run on a stored session cookie (10 posts in ~1.5s and ~0.9s).
- **CDP group — needs the shared browser**: `facebook` reach (`fb-reach.mjs`), and `brunch`
  (`stats.mjs`) when its cookie has expired and it self-heals. Run these one at a time; they
  drive one browser and racing them drops results.

Recommended pattern: fire the browserless jobs in the background, run `fb-reach` in the
foreground, then `wait`.

```bash
# browserless (parallel)
( cd ${CLAUDE_PLUGIN_ROOT}/scripts/linkedin   && node stats-fast.mjs ) &
( cd ${CLAUDE_PLUGIN_ROOT}/scripts/naver-blog && node stats.mjs ) &
( cd ${CLAUDE_PLUGIN_ROOT}/scripts/remember   && node stats.mjs ) &
( cd ${CLAUDE_PLUGIN_ROOT}/scripts/threads    && node stats.mjs ) &
( cd ${CLAUDE_PLUGIN_ROOT}/scripts/facebook   && node stats.mjs ) &
( cd ${CLAUDE_PLUGIN_ROOT}/scripts/x          && node stats.mjs ) &
( cd ${CLAUDE_PLUGIN_ROOT}/scripts/brunch     && node stats.mjs ) &
( cd ${CLAUDE_PLUGIN_ROOT}/scripts/instagram  && node stats.mjs ) &
# CDP
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
- **Instagram insights need `instagram_manage_insights`.** Without it views/reach/saved/shares
  read `—` while likes and comments still work. Re-consenting without editing the app's permission
  set re-applies the OLD scopes — it looks like it worked and changes nothing.
- **Facebook reports views, not reach.** Impressions/reach are deprecated in the Graph API AND
  Meta removed reach from Business Suite for content published after 2025-07-31, so `fb-reach.mjs`
  scrapes the Business Suite content table for view counts; engagement comes from `stats.mjs`.
  That table also lists a connected Instagram account's rows, which carry the same opening line —
  the scraper filters by each row's platform badge, so don't "simplify" it to caption matching.

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
| Naver Blog | ✓ | ✓ | `node post-api.mjs --delete <id>` / `--edit <id> <file>` |
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
  set -a; . "${CROSSPOST_HOME:-$HOME/.crosspost}/.env"; set +a
  curl -sG "https://graph.facebook.com/v21.0/<fbPostId>" \
    --data-urlencode fields=full_picture \
    --data-urlencode "access_token=$FACEBOOK_PAGE_ACCESS_TOKEN"
  cd ${CLAUDE_PLUGIN_ROOT}/scripts/threads && node post-api.mjs --image-url "<full_picture-url>" "$CROSSPOST_HOME/posts/<slug>.txt"
  ```
  Source the token — never paste it literally, or it lands in shell history, `ps`, and the transcript.
  If Facebook is not configured, Threads publishes **text-only** unless you pass an explicit `--image-url`.
- **Remember is an unofficial API.** It is experimental and may break without notice. Treat any
  failure as non-fatal to the other channels.
- **Brunch / Naver sessions expire occasionally.** When a browser channel reports a login/session
  error, re-login manually in the CDP browser window (`npm run browser`) and retry.
