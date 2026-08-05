---
name: brunch-server-side-impossible
description: 브런치 인증은 엔드포인트마다 다르다 — /v2/me·통계는 브라우저 컨텍스트 전용, 구독 목록은 공개(plain fetch), 라이킷은 curl_cffi 기본 전송만 200(impersonate 켜면 401)
type: reference
created: 2026-07-27
updated: 2026-08-05
---

**2026-08-05 정정 — 구 제목의 "브런치 API는 서버측 불가"는 과일반화였다.** 그때 잰 것은 `/v2/me`(내 계정 사설정보)와 통계(ranking·likeCount)뿐인데, 그 결과를 브런치 API 전체로 접었다. 팔로우 도구를 붙이며 엔드포인트가 세 부류로 갈린다는 게 드러났다.

| 엔드포인트 | 전송 | 비고 |
|---|---|---|
| `/v2/me`, 통계(ranking·글 HTML likeCount) | **브라우저 컨텍스트만**(in-page fetch 200 / node fetch 401) | 구 기록 그대로 유효 |
| 구독 목록 `/v2/subscription/user/@@<uid>/{followers,writers}` | **공개** — 쿠키·CDP 없이 plain node fetch 200(브라우저 UA만 필요) | 유효성 게이트로 `/v2/me`(사설)를 본 게 오판의 원인 |
| 라이킷 목록 `/v1/likeit/users/<articleNo>` | **curl_cffi 기본 전송만 200.** node fetch·시스템 curl(HTTP/1.1·HTTP/2)은 401 | 헤더가 아니라 TLS 스택을 본다 |

**라이킷의 반직관 함정**: `impersonate=chrome|chrome124|chrome131|safari17_0`은 전부 **401**이고 impersonate 없는 기본 전송만 200이다(각 3회 재현). 즉 스텔스가 도움이 아니라 방해다 — 스텔스를 기본으로 켜는 fetcher 라이브러리를 얹으면 이 엔드포인트가 깨진다. 그래서 `scripts/brunch/likeit_users.py`가 하부 전송만 옵션 없이 쓴다.

구 기록이 다음 각도로 "TLS 지문"을 지목했는데 **그게 맞았다**(라이킷 한정). 다만 그 성질이 `/v2/me`에도 적용되는지는 확인 안 했다.

**Why:** 두 방향의 재시도 낭비를 다 막으려는 기록이다 — "브런치는 전부 브라우저 필요"라고 믿고 공개 목록까지 CDP로 끌지 말 것, 반대로 "curl_cffi면 다 뚫린다"고 `/v2/me`에 같은 기대를 걸지도 말 것.

**How to apply:** 발행(Froala UI)과 통계는 CDP 유지. 팔로우 조회(follow-back)는 완전 browserless. 라이커 조회만 Python 사이드카(`pip3 install curl_cffi`, 미설치는 fail-fast). 새 브런치 엔드포인트를 붙일 땐 **그 엔드포인트로 직접** 세 전송(node fetch → curl_cffi 기본 → in-page)을 재 볼 것 — 옆 엔드포인트 결과를 이식해 추정하지 말 것.
