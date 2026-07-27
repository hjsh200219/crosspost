---
created: 2026-07-27T12:10:00+09:00
project: crosspost
summary: 브라우저 의존을 3경로에서 걷어내고(LinkedIn·네이버 통계, 네이버 발행) Instagram을 8번째 채널로 신설. v0.2.0 → v0.4.0.
---

## Session Digest

원본 repo(shconsulting)에서 통계·발행의 브라우저 의존을 걷어낸 작업을 이 플러그인에 이식하고, 이어서 Instagram 채널을 새로 만들었다. 이식분은 원본에서 실계정으로 검증된 것이고, IG 카드 생성기는 브랜드 결합 때문에 **그대로 옮기지 않고 범용판으로 다시 썼다**.

## Progress

**완료**
- `scripts/lib/site-cookie.mjs` 신설 — env 우선 + CDP 재캡처·`$CROSSPOST_HOME/.env` 영속
- **LinkedIn 통계 browserless** — 분석 페이지가 SSR, `li_at` 쿠키만. `--all`만 CDP 유지
- **네이버 통계 browserless** — cv/like는 서버 직접 호출, 댓글만 `m.blog` 문서에서
- **네이버 발행 browserless** (`http-publish.mjs` 신설) — 엔드포인트 4개, `--ui` 폴백 유지. `--edit`/`--delete`는 아직 UI
- **네이버 `--delete` 수정** — 공유 브라우저에서 confirm 경쟁으로 실제 삭제가 안 되면서 성공을 보고하던 것
- **fb-reach 전면 재작성** — Business Suite 콘텐츠 표(classic asset id), FB/IG 행 배지 필터, 그리드 자체 스크롤. `FACEBOOK_PAGE_ASSET_ID` 신설
- **Instagram 채널 신설(8번째)** — `post-api`·`stats`·`gen-cards`·`gen-reel`·`check-cards`·`card-rules`
- 문서 갱신(README EN/KO·SKILL.md·CLAUDE.md), plugin.json **0.4.0**

**검증한 것 / 안 한 것**
- IG 렌더러 체인은 임시 `CROSSPOST_HOME`에서 **실제 실행**: 카드 5장·릴스 프레임 3장(1080×1350 / 1080×1920), 오버플로 검출 exit 1, 게이트가 base URL 미설정·스테일 렌더 탐지, ffmpeg 13.7초 mp4
- **발행·통계는 이 환경에서 미검증** — `~/.crosspost/.env`에 자격증명이 없다

**커밋**: `0365ce0`(browserless 이식) · `5996d67`(Instagram 채널)

## Next Steps

1. **자격증명 있는 환경에서 IG 실발행 1회** — `check-cards` → `post-api --dry-run`(컨테이너까지, Meta가 URL을 실제로 페치하는지 증명) → 실발행 → `stats.mjs`
2. **네이버 HTTP 발행도 실환경 1회 확인** — 원본에서 UI판과 36/36 컴포넌트 대조까지 했지만 이 repo의 입력 모델은 평문 `.txt`라 문서 조립 경로가 다르다. `--private`로 내보고 대조 후 삭제 권장
3. `--edit`/`--tags`를 HTTP로 옮길지 — `documentModel.documentId` + `populationMeta.logNo`로 될 가능성이 높다(미검증)
4. 릴스 원고 길이 가이드가 아직 문서에만 있다 — `gen-reel`이 컷 상한 초과를 경고하지만 `check-cards`는 안 본다

## Blockers

- **브런치는 서버측 전환 불가 확정** — [[brunch-server-side-impossible]]. 쿠키 4조합·`x-csrf-token` 동봉 전부 401
- **IG는 공개 호스팅이 없으면 쓸 수 없다** — Meta가 URL에서 페치하므로 우회 불가. 이 전제를 README에 명시했다

## Watch Out

- **LinkedIn은 `li_at` 하나만** 보낼 것 — 전체 쿠키는 400 + 빈 본문
- **`—`(측정 실패)와 `0`(진짜 0)** 구분 유지 — 조회는 3회 재시도 후에만 null
- **Business Suite 표는 FB·IG 행을 섞는다** — 캡션만 매칭하면 FB 행에 IG 숫자가 붙는다. `<img alt>` 배지 필터를 "단순화"하지 말 것
- **공유 브라우저에서 native confirm은 먼저 잡는 쪽이 이긴다** — 페이지 안에서 무력화하고, 부수효과는 되읽어 확인한 뒤에만 장부 갱신
- **IG는 발행 후 아무것도 못 고친다** — `check-cards`와 `--dry-run`이 실질적 게이트
- **`node_modules`가 repo에 없다** — 로컬에서 스크립트를 돌리려면 `npm install` 필요(이번 검증은 설치본 캐시를 임시 심볼릭 링크해 돌리고 지웠다)

## Files Touched

- 신규: `scripts/lib/site-cookie.mjs` · `scripts/naver-blog/http-publish.mjs` · `scripts/instagram/{post-api,stats,gen-cards,gen-reel,check-cards,card-rules}.mjs`
- 수정: `scripts/linkedin/stats-fast.mjs` · `scripts/naver-blog/{stats,post-api}.mjs` · `scripts/facebook/fb-reach.mjs`
- 문서: `README.md` · `skills/publish/SKILL.md` · `CLAUDE.md` · `.claude-plugin/plugin.json` · `package.json`
