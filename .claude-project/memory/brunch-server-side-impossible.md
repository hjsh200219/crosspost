---
name: brunch-server-side-impossible
description: 브런치 API는 브라우저 안에서만 인증된다 — 쿠키 조합·x-csrf-token 동봉 전부 401. 다른 채널을 browserless로 옮겼어도 브런치는 예외
type: reference
created: 2026-07-27
---

LinkedIn·네이버를 쿠키 기반 HTTP로 옮기면서 브런치도 같이 쟀다. **불가하다.**

- `api.brunch.co.kr/v2/me` → 페이지 안 fetch는 **200**, 서버측 node fetch는 **401**
- 쿠키 도메인 조합 4가지 전부 401: `api.*`만 / `.brunch.co.kr` / `brunch.co.kr` / 브런치+카카오 34개 전부
- 브라우저 요청에는 **`x-csrf-token` 헤더가 있다**(meta·window·localStorage·문서 HTML 어디에도 없어 출처 미상). 그 토큰을 캡처해 서버 요청에 실어도 **401 그대로**

즉 인증이 쿠키 값이 아니라 **브라우저 컨텍스트 자체**에 묶여 있다. 무엇이 그 컨텍스트를 증명하는지는 밝히지 못했다.

**Why:** "다른 채널이 됐으니 브런치도 되겠지"로 다시 시도하는 것을 막으려는 기록이다. 재시도할 거라면 위 4조합과 csrf 동봉은 이미 소진했으니 **다른 각도**(TLS 지문, 서비스워커, 요청 순서 의존)에서 시작할 것.

**How to apply:** 브런치는 CDP 경로를 유지한다. 통계 실행 계획을 세울 때 브런치는 여전히 브라우저를 탈 수 있다고 가정할 것(쿠키 만료 시 self-heal 경로).
