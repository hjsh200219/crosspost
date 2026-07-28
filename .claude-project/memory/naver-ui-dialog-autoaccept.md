---
name: naver-ui-dialog-autoaccept
description: 네이버 UI 경로는 전역 dialog 핸들러가 오류 alert를 자동 수락해 거부가 예외로 안 올라온다 — 성공 신호는 URL뿐
type: reference
created: 2026-07-28
---

`scripts/naver-blog/post-api.mjs`의 UI(에디터) 경로는 SE-ONE의 초안 복구 alert 등을 넘기려고
`page.on('dialog', ...)`로 **모든 다이얼로그를 자동 수락**한다. 부작용이 크다 — 네이버가 저장을
거부하며 띄우는 **오류 alert도 같이 수락되고 사라진다.** 그래서:

- 거부돼도 예외가 올라오지 않는다
- 버튼 클릭은 성공한 것처럼 보인다
- `waitForTimeout` 이후 코드가 그대로 진행돼 장부를 쓰고 성공을 출력한다

2026-07-28 리뷰에서 `doEdit()`이 정확히 이 상태였다. 확인 클릭 후 아무 검증 없이
`recordLedger()` + `EDITED` 출력 — 거부된 수정이 성공으로 기록됐다.

**성공 신호는 URL 하나뿐이다.** 저장이 거부되면 페이지는 에디터(`PostWriteForm`)에 그대로
남는다. 성공해야 최종 URL이 글 주소가 된다:

```js
if (logNoFromUrl(page.url()) !== String(logNo)) throw new Error(...);  // 장부 건드리지 않음
```

발행 경로(`doPublish`)는 원래 이 패턴을 쓰고 있었다 — 수정 경로만 빠져 있었다.

**HTTP 경로(`doPublishHttp`)는 다르다.** 거기선 component 구조 + 본문 signature를 되읽어
대조한다. UI 경로에 `readDocument`/`documentSignature`를 그대로 갖다 쓰면 안 된다 —
에디터가 만드는 component 형태가 HTTP 발행과 같다는 보장이 없다.

**Why:** "예외가 없었으니 성공"이 이 코드베이스의 네이버 UI 경로에서는 성립하지 않는다.
자동 수락 핸들러가 실패 신호를 통째로 삼키기 때문이다.

**How to apply:** 네이버 UI 자동화를 새로 추가할 때(발행 팝업·카테고리·삭제 등) 클릭 후
반드시 관측 가능한 상태 변화를 확인할 것 — 보통 URL. 확인 전에는 장부를 쓰지도, 성공을
출력하지도 않는다. 같은 계열의 무증상 실패로 [[naver-tag-input-traps]]도 참고.
