---
created: 2026-08-05T10:20:00+09:00
project: crosspost
summary: 원본 publish 스킬의 드리프트 7건을 역동기화하고, 팔로우/조회 도구(8채널 + 친구요청 수락)를 배포본에 편입했다.
---

## Session Digest

두 덩어리를 한 커밋(`b4b2f35`)으로 올렸다. 앞은 원본 `SHC/shconsulting`에서 갈라진 뒤(마지막 동기화 `6bef50a`, 2026-07-28 13:27) 쌓인 **공유 파일 내용 드리프트** 반영이고, 뒤는 사용자 지시로 보류를 뒤집어 편입한 **팔로우/조회 도구**다.

역동기화의 방법론적 교훈이 하나 있다 — 파일 목록 diff는 "여기 없는 파일"만 보여 주는데, 실제 사용자에게 보이던 결함(15일 창 밖 네이버 글의 조회수가 전부 0)은 전부 **양쪽 다 있는 43개 파일 안**에 있었다. 원본 커밋을 시점으로 잘라 hunk를 직접 본 뒤에야 7건이 드러났다.

팔로우 도구는 원본을 복사한 게 아니라 배포본 계약으로 다시 짰다. 장부가 `$CROSSPOST_HOME/ledgers/`로 옮겨 가면서 코어 계약이 `{dir}` → `{channel}`로 바뀌었고, 원본이 SKILL 산문에만 두던 위험 게이트를 **코드로 내렸다**(채널별 보수적 기본값 + 비-dry 실행 경고 + 지연 범위 클램프). 남이 쓰는 도구는 프롬프트를 안 읽는다는 전제다.

## Progress

- 완료: 네이버 조회수를 수명 누적(`dashboard.cvTotal`)으로 전환 — 구 15일 창 합산은 창 밖 글을 전부 0으로 냈고 다른 채널과 기준도 달랐다. 구 동작은 `--window`, 블록은 `dataId`로 탐색
- 완료: Threads 훅 드리프트 게이트(`.threads.txt` 첫 줄이 정본과 다르면 중단, `--allow-hook-drift`가 탈출구)
- 완료: 브런치 카카오 로그인 성공 판정을 `bid` 존재 → 인증된 in-page `/v2/me`로 교체(익명 세션도 bid를 가져 폼을 한 번도 안 채우고 LOGGED_IN을 반환하던 함정)
- 완료: 브런치 tier3 폼 로그인 실패 사유 노출(`catch {}`가 "미시도"와 "로그인은 됐는데 세션 무효"를 같은 문장으로 만들던 것)
- 완료: 브런치 통계 생존 판정을 `--limit` 절단보다 먼저 + `--prune`(덮어쓰기 전 `.bak` 백업)
- 완료: fb-reach를 뷰포트 사다리로 교체(행수는 스크롤이 아니라 뷰포트 높이의 함수, 구 "더 보기" 루프가 누른 건 컬럼 선택기). 오버라이드는 항상 해제 — 브라우저 공유
- 완료: IG 릴스 판정을 존재 → 재생가능성(`lib/mp4.mjs` ffprobe)으로. 리멤버 장부에 `id` 기록
- 완료: `lib/totals.mjs` — 합계는 측정된 것만 더하고 결손 열은 `(k/m measured)` 표기
- 완료: 팔로우 도구 8채널 + `lib/follow-core.mjs` + 브런치 라이커 Python 사이드카 + `facebook/accept-requests.mjs`
- 완료: SKILL §10·§11, README 영·한, `config/.env.example` "Follow tools" 블록, CLAUDE.md 새 절
- 완료: 회귀 테스트 31 → 34(측정 합계 커버리지 / 장부 dedup·cap·dry-run 무기록·blocked≠followed / 지연 클램프)
- 검증: `npm run check` 34/34, `git diff --check` 통과, 개인 식별자 grep 0건
- 푸시: `b4b2f35`가 `origin/main`에 반영됨. 플러그인 버전 `0.4.1` → `0.6.0`

## Next Steps

1. **자격증명 있는 fresh home에서 실제 발행을 한 번 돌린다.** 이번에도 write 경로는 하나도 안 태웠다 — 네이버 `--window`/기본 조회수, 브런치 `--prune`, fb-reach 사다리, IG 릴스 게이트가 전부 미검증이다.
2. **팔로우 write 경로 검증.** dry-run만 돌았다. 저위험 채널(x·remember)에서 `--max 1`로 한 건씩 태워 장부 상태(`followed`/`unconfirmed`)와 재조회 확인이 실제로 도는지 볼 것. 고위험 4채널은 사용자 명시 승인 전까지 태우지 말 것.
3. **브런치 라이커 사이드카를 curl_cffi 설치 환경에서 한 번 실행**해 `pip3 install curl_cffi` 안내 경로와 정상 경로를 둘 다 확인한다.
4. **accept-requests의 가상 스크롤**은 원본에서도 미해결이다(헤더 14 vs 회수 5). 스크롤 컨테이너를 찾는 시도를 한 번 더 해볼 가치가 있다.
5. 원본에 또 드리프트가 쌓이면 `upstream-sync-content-drift` 메모리의 4단계 절차대로. 이번 동기화 기준점은 `b4b2f35` ↔ shconsulting `aece0fe` 시점이다.

## Blockers

- 실서비스 자격증명이 없어 write 경로 전량 미검증. 이번 세션 검증은 구문 검사 + 단위 계약 + 읽기 전용 스모크 수준이다.
- fb-reach·브런치/네이버 통계 렌더 경로는 CDP·세션이 필요해 이번 스모크로도 안 닿았다.

## Watch Out

- **`--dry-run`은 쓰기만 안전하지 접촉은 안전하지 않다.** CDP 세션이 살아 있으면 실계정을 읽고(LinkedIn·Threads·친구요청 목록 실측) LinkedIn은 격리 홈 `.env`에 세션 쿠키를 영속한다. 검증용 홈은 끝나면 지울 것.
- **`followed`만 팔로우다.** `blocked`·`unconfirmed`를 집계에 넣으면 건수가 부풀려진다.
- **`blocked`는 확정 거부에만 붙인다.** 일시적 렌더 실패까지 접으면 멀쩡한 대상이 영구 제외된다(Threads `no-row` vs `not-found`가 그 경계).
- **DOM 라벨 번역 금지.** 브런치·FB·IG·Threads의 버튼 문자열은 실제 UI라 번역하면 클릭이 깨진다 — env override로만 바꾼다.
- **한 채널의 두 모드를 병렬로 돌리지 말 것.** 장부를 덮어쓰고, IG는 조회만으로도 401을 건다.
- **빈 결과를 0으로 접지 말 것.** 리더는 권위 총수를 함께 읽고 총수>0인데 파싱 0건이면 throw한다 — 접으면 `candidates=0`으로 평온하게 끝나 정상처럼 보인다.
- 브런치 인증은 엔드포인트마다 다르다(구독 목록=공개 / 라이킷=curl_cffi 기본 전송 / `/v2/me`·통계=브라우저 전용). 옆 엔드포인트 결과를 이식해 추정하지 말 것.

## Files Touched

- `scripts/lib/`: `follow-core.mjs`·`mp4.mjs`·`totals.mjs` 신설
- `scripts/*/follow.mjs` 8종 신설, `scripts/brunch/likeit_users.py`·`scripts/facebook/accept-requests.mjs` 신설
- `scripts/naver-blog/stats.mjs`·`threads/post-api.mjs`·`brunch/{cookie,kakao-login,stats}.mjs`·`facebook/fb-reach.mjs`·`instagram/{check-cards,post-api}.mjs`·`remember/remember-post.mjs` 수정
- `skills/publish/SKILL.md`·`README.md`·`CLAUDE.md`·`config/.env.example`·`test/shared-contracts.test.mjs`·`.claude-plugin/plugin.json`
