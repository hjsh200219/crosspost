---
name: browserless-transports
description: LinkedIn 통계·네이버 통계·네이버 발행이 브라우저를 쓰던 이유는 서버에서 성립하지 않는다. 쿠키 기반 HTTP로 전환한 근거와 함정 3종
type: project
created: 2026-07-27
---

세 경로가 CDP를 쓰던 이유가 **둘 다 서버측에선 사실이 아니었다**(2026-07-27, 원본 repo에서 실측 후 이식).

| 경로 | "브라우저가 필요하다"던 이유 | 실제 | 결과 |
|---|---|---|---|
| LinkedIn 통계 | 분석 페이지는 DOM 스크레이프뿐 | 그 페이지는 **SSR**이고 RSC flight 페이로드가 렌더 텍스트를 **순서대로** 담는다 | 10편 1.5초(구 ~48초), 기존 파서 그대로 |
| 네이버 통계 | cross-origin 차단 | **CORS는 브라우저에만 있다.** 서버는 그냥 호출된다 | 10편 0.9초 |
| 네이버 발행 | 공식 write API가 2020에 폐쇄됨 | 폐쇄된 건 맞지만 **SE-ONE 자체가 엔드포인트 4개 위의 얇은 클라이언트** | 3.4초(구 60~90초) |

## 함정 (전부 무증상)

1. **LinkedIn은 `li_at` 하나만 보내야 한다.** 프로필 쿠키 전체를 보내면 **400 + 빈 본문**. 쿠키를 줄인 건 최적화가 아니라 동작 조건이다.
2. **네이버 댓글만 서버 호출이 거부된다** — cbox JSONP가 `4001 Wrong ticket`(ticket·pool·referer·sec-fetch 조합 전수 실패). `m.blog` 문서의 `<div id="_post_property" commentCount="N">`로 읽는다.
3. **`—`(측정 실패)와 `0`(진짜 0)을 섞지 말 것.** 재시도 없이 한 번 실패하면 em dash가 실제 0 옆에 찍혀 둘을 구분할 수 없게 된다. 3회 재시도 후에만 null.

## 쿠키 수명

`$CROSSPOST_HOME/.env`의 `LINKEDIN_COOKIE`/`NAVER_COOKIE`에 영속(`scripts/lib/site-cookie.mjs`). **전 건 실패**일 때만 CDP에서 재캡처·재영속 후 1회 재시도한다 — 전 건 실패는 세션이 죽었다는 신호지만 한두 건 실패는 글 쪽 문제라, 같이 다루면 멀쩡한 세션을 매번 새로 캡처하게 된다.

**Why:** "브라우저가 필요하다"는 대개 관찰이 아니라 **관성**이다. 매번 "이 벽이 서버에도 있나?"를 물어야 한다 — CORS처럼 브라우저에만 존재하는 벽이 흔하다.

**How to apply:** 남은 브라우저 채널(브런치, Facebook 조회수)도 같은 질문을 다시 던져볼 것. 브런치는 이미 답이 나왔다 — [[brunch-server-side-impossible]].
