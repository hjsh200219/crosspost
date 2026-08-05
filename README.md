# crosspost

**English** · [한국어](#한국어)

**Write once, publish everywhere.** Draft a single canonical post in your own brand voice, then
cross-post it to every channel you've configured — LinkedIn, Facebook, Threads, X, Remember,
Brunch, Naver Blog, and Instagram — with per-channel body variants, unified stats, and edit/delete support.

A [Claude Code](https://claude.com/claude-code) plugin. You drive it with **`/crosspost:publish`**
(or just `/publish` when the name is unambiguous); Claude handles the drafting, the per-channel
API/browser calls, and a merged stats report.

## Prerequisites

- **[Claude Code](https://claude.com/claude-code)** — this is a Claude Code plugin.
- **Node.js 18+** — the channel scripts use native `fetch`/`FormData`; `node --version` to check.
- **A developer app per official channel you want** (LinkedIn, Meta for Facebook/Threads, X) — see
  [Setup](#setup). This is the biggest up-front cost; you only register the channels you'll use.
- **Chrome or Chromium** — needed for Brunch, Facebook view-count scraping, and initial/renewed
  session capture for browserless cookie transports. Installed on demand via Playwright if absent.
- **macOS or Linux.** Image conversion for X (webp/heic → png) shells out to macOS `sips`; on Linux,
  pass already-PNG/JPEG images.

## Install

```
/plugin marketplace add hjsh200219/crosspost
/plugin install crosspost@crosspost
```

Then run **`/crosspost:setup`** — it creates your data home, copies the `.env` and `voice.md`
templates, installs dependencies, and walks you through credentials for only the channels you
choose. The rest of this README is the reference behind that guided flow.

## What it does

- **One source in → many posts out.** Give it a **YouTube URL** (captions are extracted), a
  **GitHub repo** (an intro post *with* original-source credit), or a **topic/draft**.
- **Your voice.** It reads your `voice.md` and writes in it — you own the tone, length, and rules.
- **Rich-source angles.** For a video or repo it first offers a few candidate angles as a table and
  lets you pick, instead of guessing one.
- **Auto-detected channels.** A channel runs only when its credentials are set. Unconfigured
  channels are skipped silently — you don't need all eight.
- **Per-channel variants.** Optional `<slug>.x.txt` / `<slug>.threads.txt` sibling files override
  the body for those channels; everything else uses the canonical file. A variant has to keep the
  canonical first line — Threads refuses to publish one that drifts (`--allow-hook-drift` overrides).
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
| Naver Blog | Session-cookie HTTP | No official API | Browserless after one-time Naver login |
| Instagram | Official Graph API | Official | Publicly hosted image/video required |

The five official-API channels and Remember need **no browser for publishing**. Naver publishing
is also browserless after its session cookie is captured. Brunch drives a shared local Chromium
via CDP; Facebook view-count scraping and expired session-cookie recapture also use it.

## Setup

`/crosspost:setup` runs these steps for you; this table is the reference for where each credential
comes from. Fill in only the channels you want — set a channel's key variable in
`~/.crosspost/.env` and it turns on; leave it empty and it's skipped.

| Channel | Where to get it | `.env` variables |
|---------|-----------------|------------------|
| LinkedIn | [developer.linkedin.com](https://developer.linkedin.com) → app with `w_member_social` scope → member token | `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_PERSON_URN` |
| Facebook | [developers.facebook.com](https://developers.facebook.com) → app + Page → user token, then `node scripts/facebook/get-page-token.mjs` to exchange for a Page token | `FACEBOOK_PAGE_ID`, `FACEBOOK_PAGE_ACCESS_TOKEN` (+ `FACEBOOK_PAGE_ASSET_ID` if your Page has a separate classic id — see below) |
| Threads | Same Meta app → **Threads** use case → token generator | `THREADS_ACCESS_TOKEN`, `THREADS_USER_ID` |
| X | [developer.x.com](https://developer.x.com) → app → API keys + access tokens with **write** | `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` |
| Remember | Capture the bearer token from a logged-in Remember Connect session (**unofficial**) | `REMEMBER_TOKEN`, `REMEMBER_PROFILE_ID` |
| Brunch | `npm run browser` at the plugin root, log in once via Kakao | persistent profile (+ optional `BRUNCH_COOKIE`) |
| Naver Blog | `npm run browser`, log into Naver once (publishing is browserless afterwards) | `NAVER_BLOG_ID` |
| Instagram | Meta app → **Instagram** use case → Business/Creator account linked to a Page → long-lived token | `IG_USER_ID`, `IG_ACCESS_TOKEN`, `CROSSPOST_MEDIA_BASE_URL` |

Then edit **`~/.crosspost/voice.md`** to describe your brand voice — the skill reads it before
drafting every post. Optional common vars: `CANONICAL_BASE_URL` (adds a "read the full article"
trailer linking back to your own site; leave empty to disable) and `CROSSPOST_LINK_TEXT` (that
trailer's label, default `Read the full article`).

## Usage

Everything runs through **`/crosspost:publish`** (or `/publish`). Claude reads your voice guide,
drafts, and cross-posts to every configured channel.

**Publish from a source**

```
/publish https://youtu.be/VIDEO_ID          # extract captions → pick an angle → draft → post
/publish https://github.com/owner/repo       # tool/project intro, with original-source credit
/publish write a short post about <topic>    # draft directly from a topic or your own draft
```

For a YouTube video or GitHub repo, it first shows a few candidate angles as a table and lets you
pick, rather than guessing one. Add a trailing instruction to steer any of them —
`/publish https://youtu.be/… as a case study, shorter, for beginners`.

**Stats**

```
/publish                # no arguments → merged engagement table across all channels
/publish --stat         # same; explicit
```

Totals report their own coverage — a column with an unread cell prints `128 (7/10 measured)`
rather than folding the failure into a zero. Two per-channel flags are worth knowing:
`naver-blog/stats.mjs --window` swaps lifetime views for the trailing ~15-day window, and
`brunch/stats.mjs --prune` drops ledger rows whose articles were deleted on Brunch.

**Per-channel body variants** — drop a sibling file next to the canonical post in
`~/.crosspost/posts/`; the scripts swap it in automatically:

```
2026-07-22_my-post.txt           # canonical body (all channels)
2026-07-22_my-post.x.txt         # X uses this instead (short teaser)
2026-07-22_my-post.threads.txt   # Threads uses this
2026-07-22_my-post.en.txt        # appended as an English block on long-form channels
2026-07-22_my-post.tags          # Naver Blog tags (comma/newline separated)
2026-07-22_my-post.png           # sibling image → auto-attached where supported
```

Naver Blog is the only channel with tags. Spaces and special characters are stripped before
entry — Naver treats a space as a tag separator, and a rejected character silently drops every
tag after it — so `AI 법률 상담` publishes as `AI법률상담`, which is also the form people
search on. Override per run with `--tags "a,b,c"`.

**Edit / delete** (per channel, from the plugin's `scripts/<channel>/`):

```
node post-api.mjs --delete <id>          # all channels
node post-api.mjs --edit <id> <file>     # LinkedIn, Facebook, Remember, Brunch, Naver
                                         # (Threads and X: delete, then re-publish)
```

**Browser-backed tasks** — Brunch publishing, Facebook view-count scraping, and initial or renewed
Naver session capture need a live browser:

```
cd <plugin root> && npm run browser      # log into Kakao (Brunch) / Naver in the window
```

**Follow / follower list** (optional, opt-in per channel via the "Follow tools" block in
`config/.env.example`):

```
/publish list            # read-only: followers, following, follow-back candidates per channel
/publish follow          # preview candidates, then follow back / follow likers on approval
```

Each channel has `scripts/<channel>/follow.mjs` with `--follow-back` and `--follow-likers`;
`--dry-run` previews without writing anything, `--max N` caps a run, and the follow ledger lives
in `~/.crosspost/ledgers/follows-<channel>.json`.

> **Automated following is against most platforms' terms of service**, and LinkedIn and the Meta
> channels restrict accounts that do it. These tools default to a small cap, a long randomized
> delay, and a warning on any non-dry run — and `/publish follow` previews first and asks before
> touching the high-risk channels. Use them deliberately or not at all.
> Run the two modes of one channel sequentially, never in parallel: they share a ledger and a
> session, and Instagram rate-limits an account hit from both at once — reading alone is enough.
> Brunch's liker lookup additionally needs `python3` with `curl_cffi` (`pip3 install curl_cffi`).

Accepting Facebook friend requests is a separate tool, because a friend request is a mutual
connection rather than a one-way follow — it is never part of a follow run:

```
cd <plugin root>/scripts/facebook && node accept-requests.mjs --dry-run   # preview
cd <plugin root>/scripts/facebook && node accept-requests.mjs --max 3     # accept
```

## Data layout

All your state lives **outside** the plugin install (plugin installs are cache copies replaced on
update). Everything is under `$CROSSPOST_HOME` (default `~/.crosspost`):

```
~/.crosspost/
├── .env                      # channel credentials (chmod 600)
├── voice.md                  # your brand voice guide
├── posts/                    # canonical post files + per-channel variants
├── ledgers/                  # published-<channel>.json (what was posted where)
└── browser-profile/          # persistent Chromium profile for Brunch and session capture
```

Set `CROSSPOST_HOME` to relocate it. Optional common vars: `CROSSPOST_CDP_PORT` (default 9224) and
`CANONICAL_BASE_URL` (prepended to trailer links back to your canonical post; leave empty to disable).

**Browser-free after the first login.** LinkedIn stats, Naver stats and Naver publishing run on a
session cookie captured once from the logged-in browser and stored as `LINKEDIN_COOKIE` /
`NAVER_COOKIE`; the browser is only re-opened when a cookie expires. Facebook view counts
(`fb-reach.mjs`) and Brunch still need it.

### Instagram needs images, and a place to put them

Instagram is the one channel that cannot publish text, and its API does not accept binary
uploads — Meta fetches `image_url` / `video_url` from a **public URL**. So this channel has a
prerequisite the others don't: somewhere to host the media.

```bash
# 1. write a card spec (or have Claude write it) → $CROSSPOST_HOME/cards/<slug>.json
node scripts/instagram/gen-cards.mjs <slug>              # → $CROSSPOST_HOME/media/<slug>/card-NN.jpg
node scripts/instagram/gen-cards.mjs <slug> --reels      # → build/<slug>/reel-NN.jpg
node scripts/instagram/gen-reel.mjs  <slug>              # → media/<slug>/reel.mp4  (needs ffmpeg)

# 2. publish that media directory somewhere public, then point the base URL at it
#    CROSSPOST_MEDIA_BASE_URL=https://example.com/media

# 3. gate, then publish
node scripts/instagram/check-cards.mjs <slug>
node scripts/instagram/post-api.mjs   <slug> --dry-run   # builds containers: proves Meta can fetch every URL
node scripts/instagram/post-api.mjs   <slug>
```

Already have images? Skip the generator: list their URLs in
`$CROSSPOST_HOME/posts/<slug>.insta.media` (one per line) or pass `--media a.jpg,b.jpg`.

Cards render with a neutral theme and system fonts — nothing is fetched at render time. Override
any token in `$CROSSPOST_HOME/cards.theme.json`:

```json
{ "ink": "#12151a", "paper": "#faf9f6", "accent": "#c2410c", "fontStack": "'Inter', sans-serif" }
```

**Check before you publish.** Instagram cannot replace media after publishing and, in practice,
cannot change a caption either — `check-cards.mjs` is the last mechanical defence, and everything
it catches would otherwise be permanent.

**`FACEBOOK_PAGE_ASSET_ID`** — Business Suite keys its Insights view by the Page's *classic* id,
which on New Pages Experience differs from the display id used elsewhere. If `fb-reach.mjs` says
the content table is unavailable, set this to the id that prefixes your ledger's `<pageId>_<postId>`.

## FAQ

**A token stopped working.** Threads user tokens expire ~60 days (re-issue in the Threads token
generator). LinkedIn tokens expire too (re-auth in the LinkedIn developer portal). X returns 429
on rate limits and 402 when credits are exhausted — back off and retry later, don't hammer.

**Brunch/Naver ask me to log in.** Their sessions expire occasionally and cannot be renewed
automatically. Run `npm run browser` at the plugin root and log in by hand in the window; the
session persists in `browser-profile/`. Naver returns to browserless publishing after recapture.

**Do I need the Korean channels?** No. Remember, Brunch, and Naver Blog are Korea-oriented and
fully optional. Configure only the channels you use — the rest are skipped.

**Where do my drafts and metrics live?** In `~/.crosspost/posts/` and `~/.crosspost/ledgers/`,
never inside the plugin directory.

## Disclaimer

- **Remember** uses an **unofficial, undocumented API**. It is experimental and may break at any
  time without notice.
- **Brunch** is automated through a browser because it has no official write API. **Naver Blog**
  uses undocumented session-cookie HTTP endpoints after a manual login. Both can break when those
  sites change.
- **You are responsible for your own accounts** and for complying with each platform's Terms of
  Service and rate limits. Automated posting and scraping may be restricted on some platforms;
  use this tool accordingly and at your own risk.

## License

MIT — see [LICENSE](./LICENSE).

## Development checks

Run `npm test` for the regression suite or `npm run check` for tests plus JavaScript and shell
syntax validation.

---

<a id="한국어"></a>

# crosspost (한국어)

[English](#crosspost) · **한국어**

**한 번 쓰고, 모든 채널에 발행.** 정본 포스트 하나를 본인 브랜드 보이스로 작성하면 설정해 둔 모든
채널 — LinkedIn·Facebook·Threads·X·리멤버·브런치·네이버 블로그·Instagram — 로 교차발행한다.
채널별 본문 변형, 통합 통계, 수정/삭제 지원.

[Claude Code](https://claude.com/claude-code) 플러그인. **`/crosspost:publish`**(이름이 겹치지 않으면
`/publish`)로 구동하며, Claude가 작성·채널별 API/브라우저 호출·통합 통계 보고를 처리한다.

## 사전 요구사항

- **[Claude Code](https://claude.com/claude-code)** — 이 도구는 Claude Code 플러그인이다.
- **Node.js 18+** — 채널 스크립트가 네이티브 `fetch`/`FormData`를 쓴다. `node --version`으로 확인.
- **쓰려는 공식 채널마다 개발자 앱** (LinkedIn, Facebook/Threads용 Meta, X) — [설정](#설정) 참고.
  초기 진입 비용이 가장 큰 부분이며, 실제 쓸 채널만 등록하면 된다.
- **Chrome 또는 Chromium** — 브런치, Facebook 조회수 수집, 브라우저리스 쿠키 전송의 최초·갱신
  세션 캡처에 필요. 없으면 Playwright가 자동 설치.
- **macOS 또는 Linux.** X의 이미지 변환(webp/heic → png)은 macOS `sips`를 호출한다. Linux에서는
  PNG/JPEG 이미지를 바로 넘겨라.

## 설치

```
/plugin marketplace add hjsh200219/crosspost
/plugin install crosspost@crosspost
```

이후 **`/crosspost:setup`** 실행 — 데이터홈 생성, `.env`·`voice.md` 템플릿 복사, 의존성 설치, 그리고
사용자가 고른 채널만 자격증명 설정을 안내한다. 이 README의 나머지는 그 안내 흐름의 레퍼런스다.

## 기능

- **소스 하나 입력 → 여러 포스트 출력.** **YouTube URL**(자막 추출), **GitHub 레포**(원본 출처
  크레딧 포함 소개 글), 또는 **주제/초안**을 넣으면 된다.
- **본인 보이스.** `voice.md`를 읽고 그 보이스로 작성한다 — 톤·길이·규칙은 사용자 소유.
- **소스 앵글 제안.** 영상이나 레포는 하나를 임의로 고르지 않고 후보 앵글 몇 개를 표로 먼저 제시해
  사용자가 고르게 한다.
- **채널 자동감지.** 자격증명이 설정된 채널만 실행. 미설정 채널은 조용히 건너뛴다 — 8개 다 필요 없다.
- **채널별 변형.** 선택적 `<slug>.x.txt`·`<slug>.threads.txt` 형제 파일로 그 채널 본문만 교체.
  나머지는 정본 파일 사용. 변형도 **첫 줄은 정본과 같아야** 한다 — 어긋나면 Threads가 발행을
  중단한다(`--allow-hook-drift`로 우회).
- **통합 통계.** `/publish --stat`이 전 채널 장부를 읽어 최신순 통합 표 하나로 렌더.
- **수정 / 삭제.** 전 채널 삭제 가능, 5개 채널은 in-place 수정(Threads·X는 삭제 후 재발행).

## 채널

| 채널 | 전송 방식 | API 상태 | 비고 |
|------|-----------|----------|------|
| LinkedIn | 공식 Posts API | 공식 | `w_member_social` 토큰 |
| Facebook | 공식 Graph API | 공식 | Page 액세스 토큰 |
| Threads | 공식 Graph API | 공식 | 사용자 토큰, 약 60일 만료 |
| X (트위터) | 공식 API v2 | 공식 | OAuth 1.0a; 429/402 주의 |
| 리멤버 | 사설 API | **비공식 / 실험적** | 예고 없이 깨질 수 있음 |
| 브런치 | 브라우저 세션 (CDP) | 공식 API 없음 | 한국 플랫폼; 카카오 1회 로그인 |
| 네이버 블로그 | 세션 쿠키 HTTP | 공식 API 없음 | 네이버 1회 로그인 후 브라우저리스 |
| Instagram | 공식 Graph API | 공식 | 공개 호스팅 이미지/영상 필수 |

공식 API 채널 5개와 리멤버는 **발행 시 브라우저 불필요**. 네이버 발행도 세션 쿠키 캡처 후에는
브라우저리스다. 브런치는 공유 로컬 Chromium을 CDP로 구동하고, Facebook 조회수 수집과 만료된
세션 쿠키 재캡처에도 브라우저를 쓴다.

## 설정

`/crosspost:setup`이 아래 단계를 대신 수행한다. 이 표는 각 자격증명을 어디서 얻는지에 대한 레퍼런스다.
쓰려는 채널만 채우면 된다 — `~/.crosspost/.env`에 채널의 핵심 변수를 설정하면 켜지고, 비워 두면
건너뛴다.

| 채널 | 발급처 | `.env` 변수 |
|------|--------|-------------|
| LinkedIn | [developer.linkedin.com](https://developer.linkedin.com) → `w_member_social` 스코프 앱 → 멤버 토큰 | `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_PERSON_URN` |
| Facebook | [developers.facebook.com](https://developers.facebook.com) → 앱 + 페이지 → 사용자 토큰, 이후 `node scripts/facebook/get-page-token.mjs`로 Page 토큰 교환 | `FACEBOOK_PAGE_ID`, `FACEBOOK_PAGE_ACCESS_TOKEN` (페이지에 classic id가 따로 있으면 `FACEBOOK_PAGE_ASSET_ID`) |
| Threads | 동일 Meta 앱 → **Threads** 유스케이스 → 토큰 생성기 | `THREADS_ACCESS_TOKEN`, `THREADS_USER_ID` |
| X | [developer.x.com](https://developer.x.com) → 앱 → **쓰기** 권한 API 키 + 액세스 토큰 | `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` |
| 리멤버 | 로그인된 리멤버 커넥트 세션에서 bearer 토큰 캡처 (**비공식**) | `REMEMBER_TOKEN`, `REMEMBER_PROFILE_ID` |
| 브런치 | 플러그인 루트에서 `npm run browser`, 카카오로 1회 로그인 | 유지 프로필 (+ 선택 `BRUNCH_COOKIE`) |
| 네이버 블로그 | `npm run browser`, 네이버 1회 로그인(이후 발행은 브라우저 없이) | `NAVER_BLOG_ID` |
| Instagram | Meta 앱 → **Instagram** 이용 사례 → 페이지 연결된 비즈니스/크리에이터 계정 → 장기 토큰 | `IG_USER_ID`, `IG_ACCESS_TOKEN`, `CROSSPOST_MEDIA_BASE_URL` |

이후 **`~/.crosspost/voice.md`**를 편집해 본인 브랜드 보이스를 기술한다 — 스킬이 매 발행 전 이 파일을
읽는다. 선택적 공통 변수: `CANONICAL_BASE_URL`(본인 사이트로 되돌아가는 "원문 보기" 트레일러 추가,
비우면 비활성), `CROSSPOST_LINK_TEXT`(트레일러 라벨, 기본 `Read the full article`).

## 사용법

모든 것이 **`/crosspost:publish`**(또는 `/publish`)로 실행된다. Claude가 보이스 가이드를 읽고,
작성하고, 설정된 전 채널로 교차발행한다.

**소스로 발행**

```
/publish https://youtu.be/VIDEO_ID          # 자막 추출 → 앵글 선택 → 작성 → 발행
/publish https://github.com/owner/repo       # 도구/프로젝트 소개, 원본 출처 크레딧 포함
/publish <주제>에 대한 짧은 글 써줘          # 주제나 본인 초안에서 바로 작성
```

YouTube 영상이나 GitHub 레포는 하나를 임의로 고르지 않고 후보 앵글 몇 개를 표로 먼저 보여주고 고르게
한다. 뒤에 지시를 덧붙여 방향을 잡을 수 있다 —
`/publish https://youtu.be/… 사례 연구로, 더 짧게, 초보자용으로`.

**통계**

```
/publish                # 인자 없음 → 전 채널 통합 참여 지표 표
/publish --stat         # 동일; 명시적
```

합계는 **측정된 값만** 더하고, 못 읽은 셀이 있는 열은 `128 (7/10 measured)`처럼 커버리지를 함께
찍는다(측정 실패를 0으로 접지 않는다). 알아 둘 채널 플래그 둘 — `naver-blog/stats.mjs --window`는
수명 누적 대신 최근 15일 창 조회수를, `brunch/stats.mjs --prune`은 브런치에서 삭제된 글의 장부
항목을 정리한다.

**채널별 본문 변형** — `~/.crosspost/posts/`의 정본 포스트 옆에 형제 파일을 두면 스크립트가 자동으로
교체한다:

```
2026-07-22_my-post.txt           # 정본 본문 (전 채널)
2026-07-22_my-post.x.txt         # X는 이걸 대신 사용 (짧은 티저)
2026-07-22_my-post.threads.txt   # Threads가 사용
2026-07-22_my-post.en.txt        # 장문 채널에 영어 블록으로 덧붙임
2026-07-22_my-post.png           # 형제 이미지 → 지원 채널에 자동 첨부
```

**수정 / 삭제** (채널별, 플러그인 `scripts/<channel>/`에서):

```
node post-api.mjs --delete <id>          # 전 채널
node post-api.mjs --edit <id> <file>     # LinkedIn, Facebook, 리멤버, 브런치, 네이버
                                         # (Threads·X는 삭제 후 재발행)
```

**브라우저 기반 작업** — 브런치 발행, Facebook 조회수 수집, 네이버 세션 최초·갱신 캡처에는
실 브라우저가 필요하다:

```
cd <플러그인 루트> && npm run browser     # 창에서 카카오(브런치)/네이버 로그인
```

**팔로우 / 팔로워 조회** (선택 — `config/.env.example`의 "Follow tools" 블록으로 채널별 opt-in):

```
/publish list            # 읽기 전용: 채널별 팔로워·팔로잉·맞팔 후보
/publish follow          # 후보 미리보기 후 승인한 채널만 맞팔·라이커 팔로우
```

채널마다 `scripts/<channel>/follow.mjs`가 `--follow-back`·`--follow-likers` 두 모드를 제공한다.
`--dry-run`은 아무것도 쓰지 않고 후보만 보여주고, `--max N`이 한 실행의 상한이며, 팔로우 장부는
`~/.crosspost/ledgers/follows-<channel>.json`이다.

> **자동 팔로우는 대부분 플랫폼의 약관 위반**이고, LinkedIn과 Meta 채널은 이를 이유로 계정을
> 제한한다. 그래서 기본값이 작은 상한 + 긴 랜덤 지연이고 비-dry 실행마다 경고가 뜨며,
> `/publish follow`는 먼저 미리보기를 낸 뒤 고위험 채널은 사용자 승인을 받고서야 실행한다.
> 한 채널의 두 모드는 **순차 실행**할 것 — 장부와 세션을 공유하고, Instagram은 두 모드가 동시에
> 두드리면 조회만으로도 레이트 리밋을 건다. 브런치 라이커 조회는 `python3` + `curl_cffi`가 필요하다
> (`pip3 install curl_cffi`).

Facebook 친구 요청 수락은 별도 도구다 — 친구는 일방 팔로우가 아니라 상호 연결이라 팔로우 실행에
섞이지 않는다:

```
cd <플러그인 루트>/scripts/facebook && node accept-requests.mjs --dry-run   # 미리보기
cd <플러그인 루트>/scripts/facebook && node accept-requests.mjs --max 3     # 수락
```

## 데이터 레이아웃

모든 상태는 플러그인 설치 디렉토리 **바깥**에 있다(설치본은 업데이트 시 교체되는 캐시 복사본).
전부 `$CROSSPOST_HOME`(기본 `~/.crosspost`) 아래:

```
~/.crosspost/
├── .env                      # 채널 자격증명 (chmod 600)
├── voice.md                  # 본인 브랜드 보이스 가이드
├── posts/                    # 정본 포스트 파일 + 채널별 변형
├── ledgers/                  # published-<channel>.json (무엇을 어디에 발행했는지)
└── browser-profile/          # 브런치 및 세션 캡처용 유지 Chromium 프로필
```

`CROSSPOST_HOME`으로 위치를 옮길 수 있다. 선택적 공통 변수: `CROSSPOST_CDP_PORT`(기본 9224),
`CANONICAL_BASE_URL`(정본 포스트로 되돌아가는 트레일러 링크에 붙음, 비우면 비활성).

## FAQ

**토큰이 안 먹혀요.** Threads 사용자 토큰은 약 60일 만료(Threads 토큰 생성기에서 재발급). LinkedIn
토큰도 만료(LinkedIn 개발자 포털에서 재인증). X는 rate limit에 429, 크레딧 소진에 402를 반환한다 —
연속 재시도 말고 물러났다 나중에.

**브런치/네이버가 로그인을 요구해요.** 세션이 간헐적으로 만료되며 자동 갱신이 불가하다. 플러그인
루트에서 `npm run browser`를 실행해 창에서 직접 로그인하라. 세션은 `browser-profile/`에 유지되고,
네이버는 재캡처 후 다시 브라우저 없이 발행한다.

**한국 채널이 꼭 필요한가요?** 아니오. 리멤버·브런치·네이버 블로그는 한국 지향이며 전적으로 선택.
쓰는 채널만 설정하고 나머지는 건너뛴다.

**초안과 지표는 어디에 저장되나요?** `~/.crosspost/posts/`와 `~/.crosspost/ledgers/`에 있으며,
플러그인 디렉토리 안에는 절대 두지 않는다.

## 고지

- **리멤버**는 **비공식·비문서 API**를 사용한다. 실험적이며 예고 없이 언제든 깨질 수 있다.
- **브런치**는 공식 쓰기 API가 없어 브라우저로 자동화한다. **네이버 블로그**는 수동 로그인 뒤
  비공개 세션 쿠키 HTTP 엔드포인트를 쓴다. 둘 다 사이트 변경 시 깨질 수 있다.
- **본인 계정에 대한 책임은 본인에게 있다.** 각 플랫폼의 이용약관과 rate limit을 준수하라. 자동 발행·
  스크레이핑이 일부 플랫폼에서 제한될 수 있으니 그에 맞게 본인 책임하에 사용하라.

## 라이선스

MIT — [LICENSE](./LICENSE) 참고.

## 개발 검증

회귀 테스트는 `npm test`, 테스트와 JavaScript·셸 구문 검증 전체는 `npm run check`로 실행한다.
