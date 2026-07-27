---
created: 2026-07-27T22:48:58+09:00
project: crosspost
summary: 8채널 발행 계약을 보강하고 회귀 테스트 22개로 잠근 뒤 main에 푸시했다.
---

## Session Digest

코드 리뷰에서 확인한 발행·삭제·통계 계약 문제를 모두 수정했다. 핵심은 `--skip-done`의 조기 종료,
API 실패 전파, 채널별 장부 독립성, Naver 되읽기 검증이며, `npm run check`로 테스트와 구문 검사를
한 번에 실행할 수 있게 했다.

## Progress

- 완료: Remember 공통 `post-api.mjs`/`stats.mjs` 진입점 추가
- 완료: Threads·Naver·Brunch `--skip-done`을 자격증명·쿠키·브라우저 접근 전에 처리
- 완료: Brunch 장부가 손상되면 중복 발행 위험을 피하도록 fail-closed 처리
- 완료: Facebook·Instagram 삭제 응답을 검증하고 성공 확인 후에만 장부에서 제거
- 완료: LinkedIn·Threads·X 배치 실패를 비정상 종료 코드로 전파
- 완료: fresh install의 LinkedIn 통계 빈 장부 처리
- 완료: 발행 순서 계산의 LinkedIn 장부 결합 제거, Facebook·Naver에 `publishedAt` 기록
- 완료: Naver HTTP 발행 되읽기를 component 구조·본문 signature로 비교
- 완료: Instagram canonical caption 첫 줄 보존
- 완료: README·setup·env·skill·marketplace를 8채널/Instagram/browserless Naver 기준으로 동기화
- 완료: `package-lock.json`, `npm test`, `npm run check`, Node 회귀 테스트 추가
- 검증: `npm run check` 통과(22/22), `git diff --check` 통과, `npm audit --omit=dev` 취약점 0건
- 푸시: `de97022`, `2fdd3d2`가 `origin/main`에 반영됨

## Next Steps

1. 자격증명 있는 fresh home에서 `npm ci && npm run check`를 다시 실행한다.
2. Naver private publish → readback → delete 왕복으로 실제 응답의 `documentSignature`를 확인한다.
3. Instagram `check-cards` → `post-api --dry-run` → 실제 publish → `stats.mjs`를 공개 미디어 URL로 검증한다.
4. Facebook·Instagram 실제 삭제 성공 응답 뒤 장부 prune을 테스트 계정에서 한 번 확인한다.

## Blockers

- 현재 환경에는 실서비스 자격증명이 없어 live publish/stats/delete 검증을 실행할 수 없다.
- Instagram은 Meta가 가져갈 공개 이미지/영상 URL 없이는 실제 발행 검증이 불가능하다.
- Brunch는 UI/CDP 자동화 의존이 남아 있다.
- Naver는 비공개 세션 쿠키 HTTP 엔드포인트라 사이트 응답 구조 변경 위험이 있다.

## Watch Out

- `--skip-done`은 credential, cookie, browser, API 접근보다 먼저 실행한다.
- 손상된 장부를 빈 장부로 간주하지 않는다. 중복 발행 방지를 위해 fail-closed가 기본이다.
- 다른 채널 장부에서 발행 시각을 빌리지 말고 각 장부에 `publishedAt`/`ts`를 기록한다.
- Facebook·Instagram 삭제는 HTTP 상태와 응답의 성공 확인 값을 함께 검증한다.
- Naver readback은 component 구조와 텍스트 signature를 함께 비교한다.
- Instagram canonical caption의 첫 줄을 제거하지 않는다.
- `console.log`는 CLI 사용자 출력이 많으므로 디버그 잔여물로 일괄 제거하지 않는다.

## Files Touched

- 공통/워크플로: `scripts/lib/publish-order.mjs`, `skills/publish/SKILL.md`
- 채널: `scripts/{brunch,facebook,instagram,linkedin,naver-blog,remember,threads,x}/`
- 테스트: `test/`, `test-support/`, `package.json`, `package-lock.json`
- 문서/설정: `README.md`, `commands/setup.md`, `config/.env.example`, `CLAUDE.md`,
  `.claude-plugin/marketplace.json`
