# crosspost — 개발 노트

배포용 Claude Code 플러그인. 하나의 정본 글을 LinkedIn·Facebook·Threads·X·리멤버·브런치·네이버 블로그·Instagram 8채널로 교차 발행한다.

## 세션 시작 시 필수

새 세션 시작 시 `.claude-project/HANDOFF.md`를 반드시 읽어 이전 세션 컨텍스트를 파악한다. 그 후 `.claude-project/memory/MEMORY.md` 인덱스를 훑고 관련 메모리를 함께 본다.

## 이 repo의 성격

**배포물이다.** `SHC/shconsulting`의 발행 스크립트에서 갈라져 나왔지만 **복제본이지 심볼릭 링크가 아니다.** 한쪽을 고쳐도 다른 쪽은 따라오지 않는다.

원본 대비 의도적으로 제외된 것: 백필류 one-off 스크립트, `insights.ts` 결합 스크립트(`extract-insight.mjs` 등), Chrome 프로필, 장부. 그래서 **입력 모델이 다르다** — 이쪽은 평문 `.txt` 파일, 원본은 insights slug다. 원본의 기능을 가져올 때 그대로 복사되지 않는 이유가 대개 이것이다.

## 브라우저 의존은 2채널로 줄었다 (2026-07-27)

원본에서 이식했다. **LinkedIn 통계·네이버 통계·네이버 발행**이 세션 쿠키 기반 HTTP로 돌아간다 — LinkedIn 분석 페이지는 SSR이고, 네이버의 cross-origin 벽은 CORS라 서버에는 없으며, SmartEditor ONE은 엔드포인트 4개 위의 얇은 클라이언트다(`scripts/naver-blog/http-publish.mjs`). 남은 브라우저 용도는 **브런치**와 **Facebook 조회수 스크레이프**, 그리고 쿠키 최초 캡처·만료 재캡처뿐이다.

원본에서 실측·검증한 것(같은 정본을 UI판/HTTP판으로 발행해 36/36 컴포넌트·본문 불일치 0)을 옮긴 것이라 **이 repo에서는 라이브 검증을 못 했다.** `~/.crosspost/.env`를 갖춘 환경에서 `--private`로 한 번 내보고 문서를 대조한 뒤 삭제하는 절차를 권한다.

## Instagram은 다른 7채널과 근본이 다르다 (2026-07-27 신설)

**텍스트 발행이 불가하고, API가 바이너리 업로드를 안 받는다** — Meta가 `image_url`/`video_url`을 **공개 URL에서 페치**한다. 그래서 이 채널만 호스팅 전제가 붙는다(`CROSSPOST_MEDIA_BASE_URL`). 카드가 없으면 텍스트로 폴백하지 않고 큰 소리로 실패한다.

원본(shconsulting)의 카드 생성기는 SH 디자인 시스템·insights 토픽에 묶여 있어 **그대로 옮기지 않았다.** 엔지니어링 교훈만 가져오고 브랜드는 걷어낸 범용판이다:
- 테마는 중립 기본값 + `$CROSSPOST_HOME/cards.theme.json` 오버라이드. **렌더 시 네트워크 요청 없음**(웹폰트 미사용) — 오프라인에서도 같은 결과
- 글자 폭 추정표 대신 **페이지 안에서 오버플로를 측정**한다. 언어별 폭 계수표는 반드시 현실과 어긋나고, 그때 조용히 잘린 카드가 발행된다
- 규격 술어는 `card-rules.mjs` 한 곳(생성기·게이트가 같은 코드를 import). 두 벌로 두면 갈라진다
- 카드 초안 JSON은 **에이전트가 직접 쓴다**(원본의 `claude -p` 셸아웃 없음)

`check-cards.mjs`가 발행 직전 게이트다 — IG는 발행 후 미디어 교체가 불가하고 캡션 수정도 사실상 안 되므로, 여기서 못 잡으면 영구다.

## 팔로우 도구는 발행과 계약이 다르다 (2026-08-05 신설)

`scripts/<채널>/follow.mjs` 8종 + `lib/follow-core.mjs`. 발행이 "정본 하나를 여러 채널에 뿌리는 것"이라면 이쪽은 **채널마다 계정 상태를 읽고 쓰는 것**이라 실패 모드가 다르다.

- **안전장치를 문서가 아니라 코드에 둔다.** 원본(shconsulting)은 위험 게이트가 SKILL 오케스트레이션 산문에만 있었다. 배포본은 `parseFollowArgs(argv, defaults)`가 채널별 보수적 기본값(LinkedIn `--max 5`·60~180초, Meta 3종 `--max 3`·90~300초)을 강제하고 비-dry 실행마다 `warnRealRun()`이 경고를 찍는다. 남이 쓰는 도구는 프롬프트를 안 읽는다고 가정할 것.
- **장부 상태는 넷이다** — `followed`(성립) · `failed`(재시도 가능) · `unconfirmed`(썼는데 확인 못 함, 사람이 확인·자동 재시도 없음) · `blocked`(플랫폼 확정 거부, 후보에서 영구 제외). **`followed`만 팔로우다** — 나머지를 집계에 넣으면 건수가 부풀려진다. 손상된 장부는 fail-closed(빈 걸로 읽으면 이미 팔로우한 사람에게 재발사).
- **DOM 라벨은 번역 금지.** 브런치 팔로우/팔로잉, FB 팔로우/팔로우 취소·확인, IG 팔로우, Threads 액션행 라벨은 실제 UI 문자열이라 번역하면 클릭이 깨진다. 전부 env override로 뺐다(`*_LABEL`, `FACEBOOK_FRIEND_REQUESTS_HEADING`).
- **한 채널의 두 모드는 순차.** 장부 파일과 세션을 공유하고, IG는 두 모드가 동시에 두드리면 **조회만으로도** 레이트 리밋을 건다. 채널이 다르면 병렬 OK.
- **브런치 라이커만 Python 사이드카**(`likeit_users.py`). 그 엔드포인트는 curl_cffi 기본 전송만 200이고 **스텔스 impersonation을 켜면 오히려 401**이다. 이 저장소의 유일한 Node 밖 프로세스이자 유일한 선택적 외부 의존(`pip3 install curl_cffi`) — 미설치는 fail-fast하고 follow-back에는 영향 없다.
- **친구 요청 수락(`facebook/accept-requests.mjs`)은 follow-core에 안 섞는다.** 친구는 상호 동의 관계라 일방 팔로우와 다르고, follow-core의 "모드 정확히 하나" 계약에도 안 맞는다. 자체 최소 러너를 유지한다.
- **dry-run은 읽기 전용이지만 실계정을 읽는다.** CDP 세션이 살아 있으면 `--dry-run`도 실제 팔로워·요청 목록을 조회한다(LinkedIn은 세션 쿠키를 `.env`에 캡처·영속까지 한다). 검증용 격리 홈을 쓰더라도 그 홈에 실세션 쿠키가 남으므로 끝나면 지울 것.

## 사용자 상태는 전부 `~/.crosspost`

`CROSSPOST_HOME` — `.env`(자격증명)·`voice.md`·`posts/`·`ledgers/`·`browser-profile/`. 플러그인 설치본은 업데이트 시 교체되는 캐시 복사본이므로 상태를 그 안에 두면 안 된다.

## 배포 시 주의

### git push는 더 이상 릴리스가 아니다 (2026-08-05)

`marketplace.json`의 `source`가 `"./"`에서 **npm**(`crosspost-plugin`)으로 바뀌었다. 예전에는 push하면
마켓플레이스가 git 트리를 그대로 읽어 그게 곧 배포였다. 지금은 **`npm publish`를 해야 사용자에게
닿는다** — push만 하면 레포 HEAD와 사용자가 받는 코드가 조용히 갈라진다. 버전 핀을 걸지 않아
사용자는 항상 `latest`를 받으므로, **미발행 커밋은 존재하지 않는 것과 같다.**

릴리스 순서:

1. `.claude-plugin/plugin.json`과 `package.json`의 `version`을 **함께** bump — 회귀 테스트가 둘의
   일치를 강제한다(`the npm package and the plugin manifest declare the same version`)
2. `npm run check`
3. `npm pack` 후 **파일 목록을 눈으로 확인** — `files` 화이트리스트를 쓰면 npm이 `.gitignore`를
   더 이상 참조하지 않는다. 실제로 `scripts/*/`에 쌓인 `.omc/` 상태(절대경로·세션 ID)가 tarball에
   들어간 적이 있다. `.npmignore`가 막고 있지만 확인은 절차다
4. commit + push
5. **`npm publish`** ← 이걸 빼먹으면 1~4가 사용자에게 아무 의미가 없다

버전을 bump하지 않으면 `plugin update`는 여전히 no-op이다. 캐시 갱신이 안 먹으면 uninstall + reinstall.

npm 인증은 `~/.npmrc`의 granular 토큰을 그대로 쓴다(계정 `inter349`). **`npm login` 금지** — 웹 세션
토큰이 granular 토큰을 덮어써 E403이 난다. 상세는 `SHC/novice/.claude-project/memory/npm-publish-flow.md`.

### 그 외
- 로컬 검증 기본값은 `npm run check`다. `node --test`, `scripts/**/*.mjs` 문법 검사,
  `skills/**/*.sh` 문법 검사를 묶는다
- **syntax check와 grep만으로 검증했다고 하지 말 것.** 실제 설치한 fresh-home에서 한 번 돌려봐야 한다
- 개인 경로·계정 ID(`edb_development`, `inter349` 등)가 섞이지 않았는지 확인
