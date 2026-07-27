---
name: ledger-local-publish-ordering
description: Stats ordering must stay ledger-local; never borrow publish times from another channel's ledger.
type: project
created: 2026-07-27
---

통계 행의 발행 시각은 각 채널 장부의 행만으로 계산한다.

`scripts/lib/publish-order.mjs`의 우선순위:

1. `ts`
2. `publishedAt`
3. `urn`에 인코딩된 발행 시각
4. 레거시 `date`
5. `0`

Facebook이나 Naver의 `file`/`slug`를 `published-linkedin.json`과 맞춰 시각을 빌리던 예전
동작을 복원하지 않는다. LinkedIn은 명명된 계정마다 장부가 달라질 수 있어, 다른 채널 행이 잘못된
계정의 발행 시각으로 정렬되는 숨은 전역 결합이 생긴다.

새 Facebook/Naver 장부 행에는 `publishedAt`을 기록하고, 기존 행만 `date`로 폴백한다.

**Why:** 채널 간 시각 차용은 통계가 다른 채널의 전역 상태에 의존하게 만들며 LinkedIn 다중 계정에서
특히 잘못된다.

**How to apply:** 채널 장부를 추가하거나 변경할 때 발행 순간의 전체 시각을 `publishedAt` 또는 `ts`로
저장한다. 통계 코드는 자기 행만 `publishMs(row)`에 넘기며 다른 채널 장부를 읽지 않는다.
