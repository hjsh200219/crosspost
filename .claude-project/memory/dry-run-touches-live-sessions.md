---
name: dry-run-touches-live-sessions
description: CDP 세션이 살아 있으면 --dry-run도 실계정을 읽고(LinkedIn은 쿠키를 .env에 영속) 격리 홈에 실세션이 남는다 — 검증 후 삭제 필수
type: project
created: 2026-08-05
---

`CROSSPOST_HOME`을 임시 디렉터리로 돌려 "격리된 fresh-home 스모크"를 돌려도, **CDP :9224에 로그인 세션이 살아 있으면 조회는 실계정으로 나간다.** 2026-08-05 실측:

- LinkedIn `follow.mjs --dry-run` → `resolveCookie`가 CDP에서 **실세션 쿠키를 캡처해 그 격리 홈의 `.env`에 영속**하고 팔로워 237명·후보 2명을 실제로 읽었다.
- Threads `--dry-run` → 팔로워 모달을 전량 스크롤해 401명 중 395 레코드 회수.
- `accept-requests.mjs --dry-run` → 실제 대기 중인 친구 요청 목록을 읽었다(헤더 14건 중 5건 렌더).

전부 읽기 전용이라 팔로우·수락·장부 기록은 없었지만, **(a) 남의 눈에는 자동화 조회 트래픽이고 (b) 임시 디렉터리에 유효한 세션 쿠키가 남는다.** IG는 조회만으로 레이트 리밋과 자동화 경고를 겪은 전력이 있다.

**Why:** "dry-run이니까 안전하다"는 절반만 맞다. 안전한 건 *쓰기*지 *접촉*이 아니다. 그리고 시크릿 위생 관점에서, 검증용이라 방심하고 남긴 temp `.env`가 실계정 쿠키를 담고 있다.

**How to apply:**
1. fresh-home 스모크는 **자격증명 부재 fail-fast를 확인하는 용도**로 쓴다. CDP 채널까지 태울 거면 실계정 조회가 나간다는 것을 알고 하고, 사용자에게 보고할 것.
2. 끝나면 격리 홈을 `rm -rf`로 지운다(`.env`에 캡처된 쿠키 때문).
3. 쓰기 경로는 이 방식으로 검증되지 않는다 — "스모크 통과"를 write 검증으로 보고하지 말 것.

관련 [[follow-tooling-contracts]].
