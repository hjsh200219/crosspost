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
| `follow` / `f` / "맞팔" / "follow back" | **§10 Follow** — follow back and follow likers across channels; do not draft |
| `list` / `l` / "팔로워 조회" | **§11 List** — read-only follower/following/candidate report |
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
  the paragraphs below diverge. **Threads enforces this**: `post-api.mjs` refuses to publish
  when `<slug>.threads.txt` opens differently from the canonical file (first 25 characters),
  and `--allow-hook-drift` is the deliberate override. The rule is not stylistic — the posts
  that broke it, all of which opened with a quote or a scene instead of the conclusion, reached
  about half the audience of the ones that kept it.
- **Name the thing in the title.** When the subject is a proper noun — a tool, product, plugin,
  feature — put that name in the first line as it is written. A descriptive paraphrase drops the
  one word people search for, and the first line flows on into every channel's title.
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
- **Brunch is the one channel that publishes through the browser**, and Naver still needs it for
  cookie capture and for `--edit`/`--delete`. Both use the shared CDP browser:
  ```bash
  cd ${CLAUDE_PLUGIN_ROOT} && npm run browser
  ```
  This launches Chromium with a persistent profile on `CROSSPOST_CDP_PORT` (default 9224).
  The **first time**, a human must log in once (Kakao for Brunch, Naver for Naver Blog) in that
  window; the session persists in `browser-profile/`. Automated re-login is not possible for these.
- **A browser channel cannot be turned into an API channel by swapping HTTP clients.** Brunch's
  session authenticates only inside a live `brunch.co.kr` document — the same cookie sent from
  outside the page gets a 401 — and the Meta surfaces that still need a browser (Facebook's
  Business Suite table) depend on anti-abuse tokens (`fb_dtsg`, `lsd`, `__csr`) that are minted
  and signed per page load. A stealthier client does not help: a stealth fetcher is itself a
  browser, and it cannot mint those tokens either. Read requests are a different question and
  most of them do run browserless — it is the in-page binding, not the client, that decides.
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

A total is the sum of what was **measured**. When a column holds any `—`, the scripts print the
coverage next to the total (`128 (7/10 measured)`) — never fold an unmeasured cell into 0, or a
run where every read failed reports "0 views" and reads as "nobody looked at it".

Platform quirks to note under the table:
- **Naver views are lifetime totals** (`node stats.mjs --window` switches to the trailing ~15-day
  window instead). The stats API returns both, and the window is the trap: any post older than
  about two weeks reports 0 through it no matter how many views it really has, and every other
  channel here reports lifetime figures. Views still **finalize daily**, so a post published today
  shows 0 until the next day in either mode.
- **Brunch keeps ledger rows for deleted articles.** `stats.mjs` resolves liveness before it cuts
  the window, so a dead row can no longer eat a slot and push a live post out of view; `--prune`
  drops the confirmed-dead entries from the ledger (it scans all of it, not just the window).
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
  **How many rows that table renders is a function of viewport height**, not of scrolling,
  pagination, or the date range, so the scraper grows the viewport on a ladder (native → 4000 →
  8000 → 16000px) and stops once every requested post is matched. It always clears the override —
  the browser is shared. The row count and the date-range chip it actually read are printed with
  the results, so partial coverage is visible instead of implied.

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

---

## 10. Follow / follow-back (`/publish follow`, `f`)

Each channel ships `scripts/<channel>/follow.mjs` with two modes — **follow-back** (people who
follow you and you don't follow) and **follow-likers** (people who reacted to your recent posts).
Shared safety behavior (ledger dedup, per-run cap, delay between follows, dry-run) lives in
`scripts/lib/follow-core.mjs`, and every attempt is recorded in
`$CROSSPOST_HOME/ledgers/follows-<channel>.json`.

**Automated following breaks most platforms' terms of service.** LinkedIn's User Agreement
prohibits it outright and Meta enforces it hardest — accounts get restricted for this, and a
restriction on a real professional identity costs far more than a handful of follows is worth.
So this branch is **preview-first and gated**, and it is never run without the user asking for it.

| Mode | Channels |
|---|---|
| `--follow-back` | x · remember · brunch · naver-blog · linkedin · threads · instagram · facebook (8) |
| `--follow-likers` | x · remember · brunch · linkedin · threads · instagram · facebook (7 — Naver has no liker surface) |

**Procedure:**

1. **Check prerequisites.** The CDP channels (threads, instagram, facebook, and brunch/naver for
   writes) need the shared browser: `cd ${CLAUDE_PLUGIN_ROOT} && npm run browser`. Channels whose
   follow-specific variables are unset (see `config/.env.example`, "Follow tools") sit the run out
   — say which ones were skipped rather than quietly dropping them.
2. **Preview every configured channel with `--dry-run`** — it reads only, writes nothing to the
   ledger, and follows no one:
   ```bash
   cd ${CLAUDE_PLUGIN_ROOT}/scripts/<channel> && node follow.mjs --follow-back --dry-run
   cd ${CLAUDE_PLUGIN_ROOT}/scripts/<channel> && node follow.mjs --follow-likers --dry-run [--posts N]
   ```
   Different channels may run in parallel. **Two modes of the SAME channel must run sequentially**
   — they share one ledger file and one session, and Instagram rate-limits an account that hits it
   from both at once (reading alone is enough to trigger it). Merge the results into one table:
   `Channel | follow-back candidates | liker candidates`, with failures shown as `—` and
   structurally-impossible cells as `✗`, never as `0`.
3. **Execute by risk tier**, only after the user has seen the preview:
   - **Lower risk, run on request**: `x` · `remember` · `brunch` · `naver-blog`.
     `node follow.mjs <mode> --max N`. Start small (`--max 2` on Naver, whose write is a
     multi-step form) and split large batches.
   - **High risk — ask first, per channel**: `linkedin` · `threads` · `instagram` · `facebook`.
     Show the candidates and run only the channels the user explicitly approves. Their built-in
     defaults are already conservative (`--max 3–5`, 60–300s between follows), and a non-dry run
     prints a warning naming the risk. **The gate belongs to the channel, not the mode** —
     approving a channel approves both of its modes.
   - Within one channel run **follow-back first, then follow-likers**. Someone who both follows
     you and liked a post appears in both lists; whichever runs first records them, and the second
     mode's dedup drops them. Never run the two concurrently — the later ledger write would
     overwrite the earlier one.
   - **The cap applies per mode**, so `--max 5` can mean up to 10 follows from one channel in a run.
4. **Report** one merged table of channel × mode with followed / failed / skipped counts. Ledger
   statuses distinguish `followed`, `failed` (retryable), `unconfirmed` (the write went out but
   could not be verified — a human checks it, no automatic retry) and `blocked` (a definitive
   platform refusal, excluded from later runs). **Only `followed` is a follow** — never count
   `blocked` or `unconfirmed` in a total.

**Per-channel notes worth surfacing when they come up:**
- **brunch** follow-likers needs `python3` with `curl_cffi` (`pip3 install curl_cffi`); the
  endpoint answers only that TLS stack. follow-back needs nothing extra.
- **threads** liker recovery is a subset by design — an aggregated notification names one person,
  so the number is not a like count.
- **facebook** needs professional mode on a personal profile for public followers to exist, and
  a fresh switch legitimately yields zero candidates.
- **naver-blog** has no liker surface at all (`✗`, not "no data").
- **linkedin** answers 405 for a minority of targets; those are recorded `blocked` so later runs
  stop re-firing a refused write.

**Facebook friend requests are a separate tool**, never part of a follow run:

```bash
cd ${CLAUDE_PLUGIN_ROOT}/scripts/facebook && node accept-requests.mjs --dry-run
cd ${CLAUDE_PLUGIN_ROOT}/scripts/facebook && node accept-requests.mjs --max 3
```

Accepting a request creates a **mutual** connection both sides consented to — a different
relationship from the one-way follow above, so it is not a mode of `follow.mjs` and is never run
implicitly by `/publish follow`. Run it only when the user asks for it, preview first, and note
that the request list is virtualized: a header count higher than the recovered rows is normal and
the tool says so rather than pretending it saw everything. Its ledger is
`ledgers/accepted-facebook.json`.

---

## 11. Follower list (`/publish list`, `l`) — read only

The same dry-run preview as §10 step 2, run on its own: report followers, following and
follow-back candidates per channel, and **follow no one**.

1. Same prerequisites as §10 step 1.
2. Run `node follow.mjs --follow-back --dry-run` for every configured channel (parallel across
   channels, sequential within one).
3. Report one table — `Channel | followers | following | follow-back candidates` — parsing the
   `followers=` / `following=` / `candidates=` lines each script prints. A channel that failed or
   is not logged in shows `—`, never `0`.
4. **If the request also mentions likes/likers**, add a liker column by running
   `node follow.mjs --follow-likers --dry-run --posts N` on the 7 channels that support it
   (again: not in parallel with the same channel's other mode). Mark Threads' number as partial
   and Naver as `✗`.
5. To actually follow anyone, point the user at §10 — this branch never writes.

Note that a dry run paginates whole follower lists, so a large account takes tens of seconds.

---
