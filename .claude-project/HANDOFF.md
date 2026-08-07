---
created: 2026-08-07T11:00:00+09:00
project: crosspost
summary: 상류에서 멈춰 있던 세 건(IG 릴스 기본값·카드 장당 합산 상한·explore 팔로우 모드)을 이식하고 0.7.0으로 npm 발행했다.
---

## Session Digest

배포본이 상류(`SHC/shconsulting`) 대비 2026-08-05 `b4b2f35`에서 멈춰 있는 것을 확인하고 세 건을 이식했다.
① IG 기본 포맷을 캐러셀에서 **릴스**로 뒤집고 릴스 장수 상한을 없앴다. ② 카드 글자 상한을 줄당에서
**장당 합산**으로 바꾸고 `body`/`checklist`를 130/160으로 올렸다. ③ 세 번째 팔로우 모드
**`--follow-explore`**(씨앗 계정 인접 탐색)를 5채널에 붙였다. threads explore에서 전량 결측을 조용한
0으로 접던 자리를 fail-loud로 고쳤고, 회귀 테스트 2건을 추가한 뒤 0.7.0으로 발행했다.

## Progress

**완료**
- IG 릴스 기본값 — `gen-cards`·`check-cards`는 플래그→스펙→릴스로, `post-api`는 `--carousel` 유무로 해석. 포맷/미디어 불일치 게이트 신설
- 카드 예산 장당 합산 전환(`body`·`checklist` 130/160, `cover`·`stat`·`quote`는 줄당 65 유지) + 위반 시 필드별 소모 내역 출력
- `--follow-explore` 5채널(x·brunch·threads·instagram·facebook) + `lib/follow-seeds.mjs` 신설
- 부수 이식 — IG 200+HTML 차단 판별, FB 확인 라벨 집합화·친구 제외·커스텀 슬러그 URL, threads 카운트 레코드 경계 파싱
- 회귀 테스트 2건(장당 예산·explore 계약) → `npm run check` 38/38
- 0.7.0 릴리스: 두 매니페스트 동기 bump → `npm pack` 감사(72파일, 유출 0) → push → `npm publish` → 레지스트리 재확인
- `_vault/projects/crosspost.md` 허브 노트 갱신·push

**미완료**
- explore 5채널 리더의 라이브 실행 (아래 Watch Out)

## Next Steps

1. **explore를 채널별로 `--dry-run` 1회씩** 돌려 리더 가정을 실측으로 확인한다. 세션이 필요한 CDP 3종(threads·instagram·facebook)은 `npm run browser` 선행. 순서는 browserless인 x·brunch 먼저.
2. IG 발행을 한 편 태워 릴스 기본 경로를 끝까지 확인한다(`gen-cards` → `gen-reel` → `check-cards` → `post-api --dry-run`). ffmpeg가 이제 기본 경로 필수 의존이라 미설치 환경에서 어떻게 죽는지도 함께 본다.
3. 상류 역동기화 잔여분 검토 — 이번에 이식하지 않은 것 중 **히어로 게이트**(`613dd59`·`ca10f1d`)는 이 repo에 `insights.ts`도 조판 생성기도 없어 의도적으로 제외했다. youtube 쇼츠·네이버 클립·insights-images 3종도 배포 스코프 밖으로 판단했으나 확정은 아니다.

## Blockers

- 없음

## Watch Out

- **explore 리더 5개는 라이브 실행 이력이 0이다.** 미검증 가정: x `/users/by/username/`의 `seed.data.id`, threads FollowersTab 페이로드의 `follower_count` 존재, IG `web_profile_info`의 `followed_by_viewer`/`requested_by_viewer`, FB 팔로워 탭의 상대경로 정규식. 플러밍(인자 파싱·씨앗·라운드로빈·거부)만 단위 테스트됐다. **첫 사용은 반드시 채널별 `--dry-run`.**
- **`CNT.reels` 하한을 3→4로 올렸다.** 상류 근거(캡이 아니라 품질 바닥)를 따랐지만 요청 범위 밖의 조임이다. 되돌리려면 `CNT.reels[0]`만 3으로.
- **`--skip-done`은 `(slug, format)` 키다.** 과거 캐러셀로 나간 글을 인자 없이 재실행하면 "미발행"으로 보인다. 실제 중복 발행은 미디어 게이트가 막는다(릴스 mp4 부재 → 실패).
- **`"format": "carousel"` 스펙 + `--carousel` 없는 발행**은 릴스로 해석된다. `post-api.mjs`가 스펙을 안 읽기 때문이고, 막아 주는 것은 스펙 해석이 아니라 미디어 게이트다.
- **ffmpeg/ffprobe가 IG 기본 경로의 필수 의존이 됐다.** 릴스가 기본이라 카드만 굽고 끝나던 경로가 사라졌다. CLAUDE.md의 "유일한 선택적 외부 의존" 서술을 이번에 정정했다.
- 상류와 이 repo의 `follow.mjs`는 **양방향으로 갈라져 있다**(이쪽은 영어 범용판). 다음 역동기화도 파일 복사가 아니라 기능 이식이다.

## Files Touched

- `scripts/instagram/` — `card-rules.mjs`, `check-cards.mjs`, `gen-cards.mjs`, `gen-reel.mjs`, `post-api.mjs`, `follow.mjs`
- `scripts/lib/` — `follow-core.mjs`, `follow-seeds.mjs`(신설)
- `scripts/{x,brunch,threads,facebook}/follow.mjs`
- `test/shared-contracts.test.mjs`
- `CLAUDE.md`, `README.md`, `skills/publish/SKILL.md`
- `package.json`, `.claude-plugin/plugin.json` (0.6.1 → 0.7.0)
