---
created: 2026-08-05T11:01:00+09:00
project: crosspost
summary: npm에 발행하고(crosspost-plugin) 마켓플레이스를 npm 경로로 전환했다 — push는 더 이상 릴리스가 아니다.
---

## Session Digest

앞 세션(`178a265`)에 이어 같은 날 두 커밋을 더 올렸다. 요청은 "npm 배포도", 이어서 "marketplace.json도
npm으로 바꿔"였다.

핵심은 **배포 채널이 git에서 npm으로 넘어갔다는 것**이다. 전에는 `marketplace.json`의 `source`가
`"./"`라 마켓플레이스가 GitHub 트리를 그대로 읽었고, push가 곧 배포였다. 지금은 npm 레지스트리의
`crosspost-plugin`을 가리키므로 **`npm publish`를 해야 사용자에게 닿는다.** 버전 핀을 걸지 않아
사용자는 항상 latest를 받는다. 사용자가 치는 두 줄(`/plugin marketplace add …` → `/plugin install …`)은
그대로다 — 바뀐 것은 그 두 줄이 무엇을 해석하느냐다.

발행 직전 `npm pack` 감사에서 **실제 유출을 잡았다.** `files` 화이트리스트를 추가하는 순간 npm이
`.gitignore` 폴백을 멈춰서, `scripts/facebook/`·`scripts/instagram/`에 쌓여 있던 OMC HUD 상태
(로컬 절대경로·세션 ID)가 tarball에 들어가 있었다. 소스 트리 검사로는 안 잡힌다 — git은 깨끗하고
grep도 0건이다. 방어를 추가한 행위가 다른 방어를 끈 케이스다.

## Progress

- 완료: `crosspost-plugin` npm 발행 — `0.6.0`(최초) → `0.6.1`(현재). `npm view crosspost-plugin version`으로 확인
- 완료: `package.json`에서 `private: true` 제거, `version`·`repository`·`engines`·`keywords`·`files` 추가
- 완료: `.npmignore` 신설 — `files`가 고른 디렉터리 *안에서* 빼는 차감 패스(`.omc/`·`.claude-project/`·`.env`·`browser-profile/`·`posts/`·`ledgers/`)
- 완료: `CLAUDE.md`에서 `.omc/` 유출 경로 차단 + 패키지에서 제외(계정 ID·비공개 upstream repo 노출). git에는 유지
- 완료: `marketplace.json` `source` → `{"source":"npm","package":"crosspost-plugin"}`, 버전 핀 없음
- 완료: `CLAUDE.md`에 릴리스 5단계 신설(두 매니페스트 동기 bump → check → pack 육안 → push → **publish**)
- 완료: README 영·한 — 두 설치 명령이 무엇으로 해석되는지(항상 latest·playwright 항상 동반·**clone은 설치가 아님**)
- 완료: 회귀 테스트 34 → 36. 신규 2건 = 매니페스트 version 동기·발행 가능성, marketplace의 `package`가 `package.json`의 `name`과 일치·핀 없음
- 완료: 틀린 메모리 2건 정정 — novice `npm-publish-flow`(토큰 위치·범위), `_vault/projects/crosspost.md`(내부 모순 제거)
- 검증: `npm run check` 36/36, tarball 71파일 유출 0건, GitHub raw manifest가 npm source 반환
- 푸시: `5a041c9`·`e8ed5b6` → `origin/main`

## Next Steps

1. **npm 경로로 실제 설치를 한 번 돌린다.** 지금 이게 **유일** 경로인데 `{"source":"npm"}` 항목으로
   `/plugin install`이 실제로 도는지는 안 봤다. 새 세션에서 `/plugin marketplace update` 후 재설치.
   tarball에 매니페스트가 있고 레지스트리가 `0.6.1`을 해석하는 것까지만 확인된 상태다.
2. **다음 릴리스는 반드시 `npm publish`까지.** push만 하면 사용자는 못 받는다. `CLAUDE.md` 5단계 참조.
3. 앞 세션 과제 그대로 — write 경로 전량 미검증. 저위험 채널(x·remember)에서 `--max 1`로 팔로우
   한 건씩 태워 장부 상태와 재조회 확인이 실제로 도는지 볼 것. 고위험 4채널은 명시 승인 전까지 금지.
4. 자격증명 있는 fresh home에서 실제 발행 1회(네이버 `--window`/기본 조회수, 브런치 `--prune`,
   fb-reach 사다리, IG 릴스 게이트가 전부 미검증).
5. `files`의 `test/`·`test-support/`는 설치본에서 실행할 일이 없다 — 다음 bump 때 정리 후보.
6. 원본 역동기화 기준점은 crosspost `b4b2f35` ↔ shconsulting `aece0fe` 시점(`upstream-sync-content-drift` 절차).

## Blockers

- 실서비스 자격증명이 없어 발행·팔로우 write 경로 전량 미검증. 이번 세션 검증도 구문·단위 계약·tarball 감사 수준이다.
- npm 소스 경로의 실설치 검증은 마켓플레이스 갱신·재설치가 필요해 이번 범위 밖이었다.

## Watch Out

- **push는 더 이상 릴리스가 아니다.** `npm publish`를 빼먹으면 레포 HEAD와 사용자 코드가 조용히 갈라진다. 미발행 커밋은 존재하지 않는 것과 같다.
- **`files`가 있으면 npm은 `.gitignore`를 안 본다.** 발행 전 `npm pack` 후 파일 목록 육안 확인이 절차다 — 자동 검사로 대체 불가([[npm-pack-ignores-gitignore]]).
- **`marketplace.json`의 `package` 이름이 `package.json`의 `name`과 어긋나면 모든 설치가 깨지는데 로컬은 무증상**이다(그 이름을 쓰는 로컬 코드가 없다). 회귀 테스트가 막고 있으니 그 테스트를 약화시키지 말 것.
- **npm 토큰은 `~/.npmrc`에 있고 `npm login`은 금지**다(세션 토큰이 granular 토큰을 덮어써 E403). 첫 `npm whoami`의 `ENEEDAUTH`는 거짓일 수 있으니 재시도로 확인 — 전역 메모리 `reference_npm_publish_auth`.
- **`--dry-run`은 쓰기만 안전하지 접촉은 안전하지 않다** — 앞 세션 그대로 유효([[dry-run-touches-live-sessions]]).
- **`followed`만 팔로우다.** `blocked`·`unconfirmed`를 집계에 넣으면 부풀려진다. `blocked`는 확정 거부에만.
- **DOM 라벨 번역 금지** — 브런치·FB·IG·Threads 버튼 문자열은 실제 UI다. env override로만.
- 브런치 인증은 엔드포인트마다 다르다(구독 목록=공개 / 라이킷=curl_cffi 기본 전송 / `/v2/me`·통계=브라우저 전용).

## Files Touched

- `.claude-plugin/marketplace.json`(npm source)·`plugin.json`(0.6.1)
- `package.json`(private 제거·version·files·repository·engines·keywords), `.npmignore` 신설
- `README.md`(영·한 설치 해설), `CLAUDE.md`(릴리스 5단계)
- `test/shared-contracts.test.mjs`(+2건, 36개)
- `.claude-project/memory/npm-pack-ignores-gitignore.md` 신설
- repo 밖: `SHC/novice/.claude-project/memory/npm-publish-flow.md` 정정, `_vault/projects/crosspost.md`, 전역 `reference_npm_publish_auth.md`
