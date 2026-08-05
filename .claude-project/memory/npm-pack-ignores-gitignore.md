---
name: npm-pack-ignores-gitignore
description: package.json에 `files`를 넣으면 npm이 .gitignore 참조를 멈춘다 — 발행 감사는 소스 트리가 아니라 tarball에서 해야 한다
type: project
created: 2026-08-05
---

`package.json`에 `files` 화이트리스트가 **없을 때만** npm은 `.gitignore`를 폴백으로 참조한다.
`files`를 넣는 순간 그 폴백이 사라지고, **허용된 디렉터리는 통째로 실린다.**

2026-08-05 최초 npm 발행 직전에 이걸로 실제 유출을 잡았다. `.gitignore`에 `.omc/`가 있는데도
`scripts/facebook/.omc/state/`·`scripts/instagram/.omc/state/`에 쌓여 있던 OMC HUD 상태가
`npm pack` 목록에 그대로 있었다. 내용은 `/Users/edb_development/...` 절대경로와 세션 ID였고,
**공개 레지스트리로 나가기 직전이었다.**

**소스 트리 검사로는 절대 안 잡힌다.** `git status`는 깨끗하고(gitignore됨), 개인 식별자 grep도
추적 파일만 보면 0건이고, 테스트도 전부 통과한다. **유출은 tarball에만 존재한다.**

**차단은 두 겹으로:**
1. `.npmignore` — `files`가 고른 디렉터리 *안에서* 빼는 차감 패스. `.omc/`·`.claude-project/`·
   `.env`·`browser-profile/`·`posts/`·`ledgers/` 등. `files`(허용)와 `.npmignore`(차감)는 서로를
   대체하지 않는다. 둘 다 필요하다.
2. **발행 전 `npm pack` 후 파일 목록 육안 확인** — 이게 절차다. 자동화된 어떤 검사도 이걸 대신하지
   못한다. 확인 항목: `.claude-plugin/plugin.json`이 **있는지**(없으면 플러그인이 아니라 스크립트
   묶음이 발행된다), 그리고 로컬 절대경로·세션 ID·계정 ID가 **없는지**.

`CLAUDE.md`도 같은 이유로 패키지에서 뺐다 — 56행에 계정 ID가 문자 그대로 적혀 있고 비공개 upstream
repo 관계도 노출한다. git에는 남는다(기여자용).

**Why:** `files`를 추가한 이유는 `.claude-project/`를 빼려던 것인데, 그 조치 자체가 `.gitignore`
폴백을 꺼서 **새로운 유출 경로를 열었다.** 방어를 추가하는 행위가 다른 방어를 끈 케이스다.

**How to apply:** 발행 전 `npm pack --pack-destination <scratch>` → `tar tzf` 목록을 읽는다.
"gitignore돼 있으니 안 실린다"는 `files`가 있는 순간 성립하지 않는다. 릴리스 5단계는
`CLAUDE.md`의 "배포 시 주의"에 있다.

같은 계열의 교훈이 두 개 더 있다 — 전역 메모리 `feedback_distributable_plugin_testing`
(syntax·grep 통과는 배포 검증이 아니다)과 [[dry-run-touches-live-sessions]](읽기 전용 플래그가
접촉까지 막아 주지는 않는다). 셋 다 **검사한 대상이 실제로 나가는 대상과 다르다**는 한 가지
실패 모드다.
