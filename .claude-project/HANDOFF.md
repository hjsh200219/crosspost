---
created: 2026-07-28T09:20:00+09:00
project: crosspost
summary: 8채널 전수 코드 리뷰를 3라운드로 돌려 확정 결함 37건을 고치고 회귀 테스트를 22→31개로 늘렸다.
---

## Session Digest

전 채널 대상 다중 에이전트 코드 리뷰를 돌리고, 반박 검증(adversarial verification)을 통과한
결함만 수정했다. 1차에서 raw 57건 → 중복 제거 후 검증 → 19건 확정(2건 반박), 3차에서
미검증으로 남아 있던 low 20건을 재검증해 18건 확정(2건 반박). 총 37건을 두 커밋으로
나눠 `origin/main`에 푸시했고, 플러그인 버전을 `0.4.0` → `0.4.1`로 올렸다.

리뷰의 핵심 축은 세 가지였다 — 중복 발행으로 이어지는 장부 계약 위반, 실패를 0이나
성공으로 위장하는 침묵 실패, 그리고 한 번도 성공한 적 없는 self-heal 경로.

## Progress

- 완료: 손상된 장부 fail-closed를 X·리멤버·브런치 append 경로까지 확장
  (append는 단순 swallow보다 나쁘다 — 손상 파일을 1건짜리로 덮어써 기록을 파괴하고,
  유효 JSON으로 세탁해 기존 fail-closed 가드를 영구 무력화한다)
- 완료: Instagram·네이버가 후속 호출(permalink 조회·readback) **전에** 장부를 기록하도록 순서 반전
  — 라이브 게시물이 장부에 없으면 `--skip-done` 재시도가 중복 발행한다
- 완료: 브런치·Threads 삭제가 확인 후 장부를 정리 (FB·IG·X와 같은 계약)
- 완료: 리멤버 `--skip-done`을 자격증명 획득 전으로 이동 + basename 대조로 경로 표기 차이 흡수
- 완료: LinkedIn 큐에 절대경로 저장 (scheduler가 chdir하므로 상대경로는 발행 시점 반드시 ENOENT)
- 완료: LinkedIn 예약 발행의 정본 첫 댓글 이중 게시 제거 (enqueue와 발행 경로가 각각 달고 있었다)
- 완료: LinkedIn·네이버 쿠키 self-heal의 `validate: () => false` 함정 수정 — 갓 캡처한 쿠키까지
  거부해 재캡처가 100% throw했다. 죽은 값만 지목하도록 변경하고 네이버엔 self-heal 신설
- 완료: Facebook 통계가 Graph 오류를 표면화하고 토큰 사망(190)에 exit 1
- 완료: X `weight()`를 twitter-text configV3로 교체 — 기본 2, weight 1은 4개 구간뿐,
  이모지는 grapheme 단위 2. 기존 구현은 이모지를 1로 세어 덜 잘랐고 실제 280을 넘겼다
- 완료: 브런치·네이버 통계에서 측정 실패를 0으로 뭉개지 않고 `—`로 구분, 합계에서 제외
- 완료: 브런치 랭킹 API 페이지네이션, Facebook `/me/accounts` 커서 추적
- 완료: IG 카드 생성기가 오버플로 검사 통과 후에만 발행 디렉터리에 쓰고 stale 프레임 제거
- 완료: 문서 정합 — 죽은 `FACEBOOK_PAGE_NAME` 제거, 실제 읽는 `FACEBOOK_PAGE_ASSET_ID`·
  `CROSSPOST_LINK_TEXT` 추가, curl 명령줄의 토큰 인라인 제거, 네이버 `--edit` 시그니처 수정
- 검증: `npm run check` 31/31 통과, `git diff --check` 통과, JSON manifest 4개 정상
- 푸시: `3320b00`, `6bef50a`가 `origin/main`에 반영됨

## Next Steps

1. 자격증명 있는 fresh home에서 `npm ci && npm run check` 후 실제 발행을 한 번 돌린다.
   구문 검사와 테스트만으로는 브라우저·CDP·실발행 경로가 검증되지 않는다.
2. 네이버 `--edit`의 새 URL 검증을 실제로 확인한다 — 성공 시 통과하고, 거부 시
   장부를 건드리지 않는지. 전역 dialog 핸들러가 오류 alert를 자동 수락하므로 URL만이 신호다.
3. 브런치 `--delete` 후 장부 prune과 draft → publish 승격을 테스트 계정에서 한 번 확인한다.
4. Instagram `check-cards` → `--dry-run` → 실제 발행 순으로 돌려 장부에 `publishedAt`이
   남는지, permalink 조회 실패 시에도 기록이 유지되는지 본다.
5. LinkedIn `--at`로 예약 → scheduler 발행까지 한 사이클 돌려 절대경로 저장과
   첫 댓글 1회 게시를 확인한다.
6. X 이모지 포함 본문을 실제 발행해 280 한도 안에 들어가는지 확인한다(로컬 reference
   계산으로는 통과했지만 X 응답으로 확정한 것은 아니다).

## Blockers

- 실서비스 자격증명이 없어 live publish/stats/delete 검증을 실행하지 못했다.
  이번 세션의 검증은 전부 테스트·구문 검사·로컬 reference 계산 수준이다.
- Instagram은 Meta가 페치할 공개 미디어 URL 없이는 실제 발행 검증이 불가능하다.
- 브런치는 UI/CDP 자동화 의존이 남아 있어 자동 테스트로 덮이지 않는다.
- 네이버는 비공개 세션 쿠키 HTTP 엔드포인트라 사이트 응답 구조 변경 위험이 상존한다.

## Watch Out

- **장부 append 경로도 fail-closed여야 한다.** 읽기 경로만 고치면 절반이다 — 쓰기가
  손상 파일을 덮어쓰면 복구 불가에 가드까지 죽는다.
- **되돌릴 수 없는 발행은 후속 호출 전에 기록한다.** publish 성공과 장부 기록 사이에
  API 호출을 끼우면 그 호출의 실패가 중복 발행으로 이어진다.
- **`resolveCookie`의 `validate`는 갓 캡처한 쿠키에도 적용된다.** 재캡처 강제에
  `() => false`를 쓰면 self-heal이 항상 죽는다. `(c) => c !== deadCookie` 형태를 쓸 것.
  (자세한 내용은 memory `browserless-transports`)
- **0과 "측정 실패"를 섞지 말 것.** 통계 스크립트에서 실패를 0으로 채우면 "참여도 0"과
  "인증 만료"가 같은 표로 보인다. `—`(null)로 구분하고 합계에서 뺀다.
- **삭제는 확인 후 장부 정리까지가 한 동작이다.** 정리하지 않으면 문서화된 delete+재발행을
  `--skip-done`이 영영 건너뛴다.
- **`--skip-done`은 status까지 대조한다.** 브런치 draft 항목을 publish 완료로 보면
  초안 승격 경로가 사라진다.
- **X 문자 가중치는 "CJK만 2"가 아니다.** twitter-text는 기본 2이고 weight 1이 예외다.
- `console.log`는 CLI 사용자 출력이 많으므로 디버그 잔여물로 일괄 제거하지 않는다.

## Files Touched

- 채널: `scripts/{brunch,facebook,instagram,linkedin,naver-blog,remember,threads,x}/`
- 공통: `scripts/lib/site-cookie.mjs`
- 테스트: `test/cli-idempotence.test.mjs` (22 → 31)
- 문서/설정: `skills/publish/SKILL.md`, `commands/setup.md`, `config/.env.example`,
  `.claude-plugin/plugin.json` (0.4.0 → 0.4.1)
- 메모리: `.claude-project/memory/browserless-transports.md` (validate 함정 추가)
