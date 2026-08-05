---
name: follow-tooling-contracts
description: 팔로우 도구 4대 계약 — 장부 상태 4종(followed만 팔로우)·안전장치는 코드에·DOM 라벨 번역 금지·한 채널 두 모드 순차
type: project
created: 2026-08-05
---

`scripts/<채널>/follow.mjs` 8종 + `lib/follow-core.mjs`를 붙이며 정한 계약. 발행 경로와 실패 모드가 달라 그쪽 관용구를 그대로 가져오면 틀린다.

**1. 장부 상태는 넷이고 `followed`만 팔로우다.**
- `followed` 성립 · `failed` 재시도 가능 · `unconfirmed` 썼는데 확인 못 함(사람이 확인, 자동 재시도 없음) · `blocked` 플랫폼 확정 거부(후보에서 영구 제외).
- **집계에 `blocked`·`unconfirmed`를 넣으면 건수가 부풀려진다** — 관계가 성립하지 않았다.
- `blocked`가 필요한 이유: 확정 거부 대상을 `failed`로 두면 매 실행 같은 거부 write를 재발사하고, 그건 자동화 탐지가 보기에 정확히 프로빙 패턴이다. 반대로 **일시적 렌더 실패까지 `blocked`로 접으면 멀쩡한 대상이 영구 제외**된다(Threads의 `no-row` vs `not-found` 구분이 이 경계).
- 손상된 장부는 fail-closed. 빈 걸로 읽으면 이미 팔로우한 사람 전원에게 다시 쏜다.

**2. 안전장치는 산문이 아니라 코드에 둔다.** 원본(shconsulting)은 위험 게이트가 SKILL 오케스트레이션 문서에만 있었다. 배포본은 `parseFollowArgs(argv, defaults)`가 채널별 기본값(LinkedIn `--max 5`·60~180초, Meta 3종 `--max 3`·90~300초)을 강제하고 비-dry 실행마다 `warnRealRun()`이 찍힌다. **남이 쓰는 도구는 프롬프트를 안 읽는다.** 부분 플래그(`--delay-min`만 지정)로 범위가 역전되면 대기가 0으로 붕괴하므로 클램프도 코어에 있다.

**3. DOM 라벨은 번역하지 않는다.** 브런치 팔로우/팔로잉, FB 팔로우/팔로우 취소·확인, IG 팔로우, Threads 액션행(맞팔로우·요청함 포함)은 실제 UI 문자열이라 번역하면 클릭이 깨진다. 전부 env override(`*_LABEL`·`FACEBOOK_FRIEND_REQUESTS_HEADING`)로 뺐다. 사용자향 출력·에러만 영어로 옮긴다.

**4. 한 채널의 두 모드는 순차, 채널 간은 병렬.** 같은 `follows-<ch>.json`에 두 프로세스가 쓰면 뒤 쓰기가 앞을 통째로 덮고(`recordFollow`가 전체 읽고 다시 씀), IG는 두 모드가 같은 세션을 동시에 두드리면 **조회만으로도** 401 레이트 리밋을 건다.

**부수 계약 둘.**
- **쓰기 성공 판정은 항상 authoritative 재조회다.** POST 200·버튼 텍스트 변화·팝업 성공 문구는 전부 거짓 신호 전력이 있다(브런치 200-no-op, FB의 라벨이 "팔로잉"이 아니라 "팔로우 취소", 네이버 팝업 문구가 거짓 실패). 재조회로 확인 못 하면 `unconfirmed`.
- **빈 결과를 0으로 접지 않는다.** 리더마다 권위 총수(`paging.total`·`user_count`·`totalCount`·모달 "팔로워 N명")를 함께 읽고, 총수>0인데 파싱 0건이면 throw한다. 접으면 `candidates=0`으로 매번 평온하게 끝나 정상처럼 보인다.

**Why:** 이 넷은 전부 "조용히 틀리는" 실패라 테스트로도 안 잡히고 로그가 평온하다. 한 번씩 다 겪은 뒤에 정한 것들이다.

**How to apply:** 새 채널을 붙이면 follow-core의 계약을 그대로 쓰고, 채널 파일에는 (a) 권위 총수 가드 (b) 재조회 확인 (c) `blocked` 판정이 확정 거부에만 붙는지 세 가지를 먼저 점검할 것. 관련 [[browserless-transports]] [[brunch-server-side-impossible]] [[dry-run-touches-live-sessions]].
