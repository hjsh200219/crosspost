# crosspost — 개발 노트

배포용 Claude Code 플러그인. 하나의 정본 글을 LinkedIn·Facebook·Threads·X·리멤버·브런치·네이버 블로그 7채널로 교차 발행한다.

## 세션 시작 시 필수

새 세션 시작 시 `.claude-project/HANDOFF.md`를 반드시 읽어 이전 세션 컨텍스트를 파악한다. 그 후 `.claude-project/memory/MEMORY.md` 인덱스를 훑고 관련 메모리를 함께 본다.

## 이 repo의 성격

**배포물이다.** `SHC/shconsulting`의 발행 스크립트에서 갈라져 나왔지만 **복제본이지 심볼릭 링크가 아니다.** 한쪽을 고쳐도 다른 쪽은 따라오지 않는다.

원본 대비 의도적으로 제외된 것: 백필류 one-off 스크립트, `insights.ts` 결합 스크립트(`extract-insight.mjs` 등), Chrome 프로필, 장부. 그래서 **입력 모델이 다르다** — 이쪽은 평문 `.txt` 파일, 원본은 insights slug다. 원본의 기능을 가져올 때 그대로 복사되지 않는 이유가 대개 이것이다.

## 브라우저 의존은 2채널로 줄었다 (2026-07-27)

원본에서 이식했다. **LinkedIn 통계·네이버 통계·네이버 발행**이 세션 쿠키 기반 HTTP로 돌아간다 — LinkedIn 분석 페이지는 SSR이고, 네이버의 cross-origin 벽은 CORS라 서버에는 없으며, SmartEditor ONE은 엔드포인트 4개 위의 얇은 클라이언트다(`scripts/naver-blog/http-publish.mjs`). 남은 브라우저 용도는 **브런치**와 **Facebook 조회수 스크레이프**, 그리고 쿠키 최초 캡처·만료 재캡처뿐이다.

원본에서 실측·검증한 것(같은 정본을 UI판/HTTP판으로 발행해 36/36 컴포넌트·본문 불일치 0)을 옮긴 것이라 **이 repo에서는 라이브 검증을 못 했다.** `~/.crosspost/.env`를 갖춘 환경에서 `--private`로 한 번 내보고 문서를 대조한 뒤 삭제하는 절차를 권한다.

## 사용자 상태는 전부 `~/.crosspost`

`CROSSPOST_HOME` — `.env`(자격증명)·`voice.md`·`posts/`·`ledgers/`·`browser-profile/`. 플러그인 설치본은 업데이트 시 교체되는 캐시 복사본이므로 상태를 그 안에 두면 안 된다.

## 배포 시 주의

- `.claude-plugin/plugin.json`의 `version`을 반드시 bump할 것. bump 없이는 `plugin update`가 no-op이다
- 캐시 갱신이 안 먹으면 uninstall + reinstall
- **syntax check와 grep만으로 검증했다고 하지 말 것.** 실제 설치한 fresh-home에서 한 번 돌려봐야 한다
- 개인 경로·계정 ID(`edb_development`, `inter349` 등)가 섞이지 않았는지 확인
