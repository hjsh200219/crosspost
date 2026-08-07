# crosspost — 개발 노트

배포용 Claude Code 플러그인. 하나의 정본 글을 LinkedIn·Facebook·Threads·X·리멤버·브런치·네이버 블로그·Instagram 8채널로 교차 발행한다.

## 세션 시작 시 필수

새 세션 시작 시 `.claude-project/HANDOFF.md`를 반드시 읽어 이전 세션 컨텍스트를 파악한다. 그 후 `.claude-project/memory/MEMORY.md` 인덱스를 훑고 관련 메모리를 함께 본다.

## 이 repo의 성격

**배포물이다.** `SHC/shconsulting`의 발행 스크립트에서 갈라져 나왔지만 **복제본이지 심볼릭 링크가 아니다.** 한쪽을 고쳐도 다른 쪽은 따라오지 않는다.

원본 대비 의도적으로 제외된 것: 백필류 one-off 스크립트, `insights.ts` 결합 스크립트(`extract-insight.mjs` 등), Chrome 프로필, 장부. 그래서 **입력 모델이 다르다** — 이쪽은 평문 `.txt` 파일, 원본은 insights slug다. 원본의 기능을 가져올 때 그대로 복사되지 않는 이유가 대개 이것이다.

## 브라우저 의존은 2채널로 줄었다 (2026-07-27)

원본에서 이식했다. **LinkedIn 통계·네이버 통계·네이버 발행**이 세션 쿠키 기반 HTTP로 돌아간다 — LinkedIn 분석 페이지는 SSR이고, 네이버의 cross-origin 벽은 CORS라 서버에는 없으며, SmartEditor ONE은 엔드포인트 4개 위의 얇은 클라이언트다(`scripts/naver-blog/http-publish.mjs`). 남은 브라우저 용도는 **브런치**와 **Facebook 조회수 스크레이프**, 쿠키 최초 캡처·만료 재캡처, 그리고 **IG 카드/릴스 프레임 렌더**다(`gen-cards.mjs`가 playwright chromium으로 오버플로를 실측한다). 릴스가 기본이 된 뒤로 IG는 발행마다 헤드리스 브라우저와 ffmpeg를 탄다 — 헤딩의 '2채널'은 발행·통계 세션 경로를 말하는 것이지 브라우저를 안 띄운다는 뜻이 아니다.

원본에서 실측·검증한 것(같은 정본을 UI판/HTTP판으로 발행해 36/36 컴포넌트·본문 불일치 0)을 옮긴 것이라 **이 repo에서는 라이브 검증을 못 했다.** `~/.crosspost/.env`를 갖춘 환경에서 `--private`로 한 번 내보고 문서를 대조한 뒤 삭제하는 절차를 권한다.

## Instagram은 다른 7채널과 근본이 다르다 (2026-07-27 신설)

**텍스트 발행이 불가하고, API가 바이너리 업로드를 안 받는다** — Meta가 `image_url`/`video_url`을 **공개 URL에서 페치**한다. 그래서 이 채널만 호스팅 전제가 붙는다(`CROSSPOST_MEDIA_BASE_URL`). 미디어(기본은 릴스 `reel.mp4`, 캐러셀은 `card-NN.jpg`)가 없으면 텍스트로 폴백하지 않고 큰 소리로 실패한다.

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
- **한 채널의 여러 모드는 순차.** 장부 파일과 세션을 공유하고, IG는 두 모드가 동시에 두드리면 **조회만으로도** 레이트 리밋을 건다. 채널이 다르면 병렬 OK. 모드가 셋이 된 뒤에도 같다(explore는 `/publish follow` 일괄 밖이라 3중 동시 실행이 실제로 생기지는 않는다).
- **브런치 라이커만 Python 사이드카**(`likeit_users.py`). 그 엔드포인트는 curl_cffi 기본 전송만 200이고 **스텔스 impersonation을 켜면 오히려 401**이다. 유일한 Python 의존(`pip3 install curl_cffi`)이고 미설치는 fail-fast, follow-back에는 영향 없다. **단 외부 바이너리 의존이 이것 하나라고 읽지 말 것** — 릴스가 기본이 되면서 `gen-reel.mjs`의 `ffmpeg`(+`lib/mp4.mjs`의 `ffprobe`)가 IG 기본 경로의 **필수** 의존이 됐고, 그 밖에 macOS `sips`가 x·브런치 이미지 변환에 쓰인다.
- **친구 요청 수락(`facebook/accept-requests.mjs`)은 follow-core에 안 섞는다.** 친구는 상호 동의 관계라 일방 팔로우와 다르고, follow-core의 "모드 정확히 하나" 계약에도 안 맞는다. 자체 최소 러너를 유지한다.
- **dry-run은 읽기 전용이지만 실계정을 읽는다.** CDP 세션이 살아 있으면 `--dry-run`도 실제 팔로워·요청 목록을 조회한다(LinkedIn은 세션 쿠키를 `.env`에 캡처·영속까지 한다). 검증용 격리 홈을 쓰더라도 그 홈에 실세션 쿠키가 남으므로 끝나면 지울 것.

## 릴스가 기본, 카드 예산은 장당 합산 (2026-08-07 상류 이식)

**IG 기본 포맷을 릴스로 뒤집었다.** 단 **해석 주체가 둘로 갈린다** — `gen-cards.mjs`·`check-cards.mjs`는
**명시 플래그 → 스펙의 `format` → 기본값 릴스**로 풀지만, `post-api.mjs`는 **스펙을 아예 안 읽고**
`--carousel` 유무로만 가른다(그 파일에 `cards/` 참조가 0건이다). 렌더·게이트에 스펙을 끼운 이유는
기존 캐러셀을 재렌더할 때 조용히 릴스로 뒤집히지 않게 하기 위해서다(프레임 크기·세이프존이
다르고 IG는 발행 후 교체가 불가하다). 캐러셀은 `--carousel`로 남아 있다.

**그래서 `"format": "carousel"` 스펙은 렌더·게이트를 캐러셀로 통과한 뒤 `--carousel` 없이 발행하면
릴스로 해석된다.** 결과가 안전한 건 스펙 해석이 아니라 **미디어 게이트** 덕이다 — 릴스인데 이미지가
잡히면 확장자로 걸러 `--carousel`을 안내한다. 이 방어가 어디 있는지 헷갈리면 게이트를 지우고
"스펙이 막아 준다"고 착각하게 된다.

- **`post-api.mjs`에 포맷/미디어 불일치 게이트를 뒀다.** 기본이 릴스가 되면서 이미지를 넘긴
  호출이 REELS 컨테이너로 갈 수 있는데, 그때 Meta가 주는 에러는 URL을 가리켜 **깨진 이미지처럼
  읽힌다.** 확장자로 먼저 걸러 `--carousel`을 안내한다.
- **`--skip-done`은 `(slug, format)` 키라 기본값 전환의 부작용이 있다** — 예전에 캐러셀로 나간
  글을 인자 없이 다시 부르면 "미발행"으로 보인다. 실제 중복 발행은 미디어 게이트가 막지만
  (릴스 mp4가 없으면 실패) 장부만 보고 판단하지 말 것.

**카드 글자 상한(`card-rules.mjs`)의 의미론이 타입마다 다르다.** `body`·`checklist`는 **장당
합산**(heading + text + items 전부)이고 130/160, 나머지 셋은 종전대로 **줄당** 65다. 줄당으로
재면 항목 수만큼 예산이 늘어나 4항목 체크리스트가 1항목짜리의 네 배를 싣고도 통과한다 —
"불릿만 나열하고 설명이 없는 카드"가 그렇게 나온다. 상한 위반 메시지는 **어느 필드가 얼마를
먹었는지 함께 찍는다**(그게 없으면 items가 넘쳤는데 heading을 줄인다).

계수는 상류(shconsulting)에서 가져왔지만 **그쪽 템플릿에서 실측한 값**이다. 여기서 안전한 근거는
`gen-cards.mjs`가 렌더 시 `scrollHeight - clientHeight`로 **실제 오버플로를 측정**해 잘린 렌더를
발행 디렉터리에 쓰지 않는다는 것 — CAPS는 더 싼 선행 게이트이지 유일한 방어선이 아니다.

**릴스 장수 상한은 없다**(`CNT.reels = [4, Infinity]`). 컷 길이는 글자 수(내레이션이 붙으면 발화
길이)가 정하므로 장수는 길이의 대리 지표가 못 된다. 하한 4는 캡이 아니라 품질 바닥이라 남긴다.
캐러셀 10은 플랫폼 한계다.

## explore — 씨앗 인접 탐색 (2026-08-07 신설)

`follow.mjs`의 세 번째 모드 `--follow-explore`. **앞의 두 모드와 같은 등급으로 다루지 말 것** —
follow-back·follow-likers는 이미 나에게 반응한 사람이라 후보가 한 자릿수인데, explore는 남의
청중에서 캐낸 **생면부지 계정**이고 후보가 수백이다.

- **씨앗은 배포물에 넣지 않는다.** 누구의 이웃을 캘지는 주제 함수라 기본 목록을 넣으면 남의
  청중이 된다. `$CROSSPOST_HOME/follow-seeds.json` + `--seed`이고, 미설정은 **에러**다
  (빈 후보로 반환하면 "더 팔로우할 사람이 없다"로 읽힌다). DOM 라벨을 env로 뺀 것과 같은 이유.
- **미지원 채널은 fail-closed다.** 채널 `main()`이 `if (follow-back) … else …(라이커)` 꼴이라
  막지 않으면 explore가 **조용히 라이커 모드로 실행된다**. `parseFollowArgs(argv, {explore:true})`를
  넘긴 채널만 허용하고 나머지는 명시적으로 거부한다 — 옵트인을 빠뜨렸을 때 결과가 "다른 동작"이
  아니라 "명확한 거부"여야 한다.
- **`--max` 기본 3**(`EXPLORE_MAX_DEFAULT`)이고 상한이 사실상 유일한 방어선이다. `runFollows`가
  잘라낸 인원을 **stderr에 따로** 찍는다 — 요약 한 줄의 `capped=366`은 "다 처리했다"로 읽힌다.
- **후보는 씨앗별 라운드로빈**이다. 이어 붙이면 `--max 3`이 항상 첫 씨앗에서만 잘려 나머지
  씨앗이 영원히 후보를 못 낸다.
- **`--seed-side` 기본은 `following`** — 큰 계정의 팔로워는 아무나 될 수 있지만 팔로잉은 본인이
  고른 목록이다. 단 Threads는 팔로잉 목록 표면이 아예 없어 `followers` 고정이고
  (`following`을 주면 조용히 팔로워를 읽지 않고 **거부**한다), FB 페이지는 팔로우하는 대상이
  거의 없어 역시 `followers`가 기본이다.
- 품질 하한 `--min-followers 30` / `--max-followers 50000`. **수치를 못 읽은 계정은 제외**한다
  (콜드에서 "모르면 건다"는 틀린 기본값). 채널마다 비용이 다르다 — X·브런치·Threads는 목록
  응답에 수치가 실려 공짜, IG는 목록에 지표가 없어 `web_profile_info`를 후보당 1회 쓰고
  `ENRICH_CAP`으로 묶는다, **FB는 지표 자체가 없어 하한을 못 건다**(대신 `filterActionable()`이
  write 전에 프로필을 열어 버튼으로 거른다).
- **FB 확인 라벨은 집합이다**(`팔로우 취소` 또는 `팔로잉`) — 하나로 핀하면 실제로 성립한 팔로우가
  `unconfirmed`로 찍히고, 그건 dedup이 안 돼 다음 실행이 같은 대상에게 write를 재발사한다.
  실패 메시지에 **관찰한 버튼 라벨을 함께** 싣는다(원인은 대개 셀렉터가 아니라 관계 상태다).
  **친구는 후보에서 뺀다** — 친구 프로필엔 팔로잉/취소 라벨이 안 떠 성립 확인이 원리적으로
  불가능하고, 애초에 "접점 없는 사람"도 아니다.
- **되돌리기 가능 여부가 채널마다 다르다.** 브런치는 unfollow 엔드포인트가 미상이라 잘못 건
  팔로우가 영구다 — `--max`로 쪼갤 것.
- **429는 `blocked`가 아니라 `failed`다** — 대상 쪽 거부가 아니라 우리 속도 문제라 재시도가
  허용돼야 맞다(LinkedIn 405를 `blocked`로 빼는 것과 반대 방향이니 섞지 말 것).
- **`/publish follow` 일괄에 넣지 않는다.** 라이커를 일괄에 넣을 때 쓴 논리("게이트는 모드가
  아니라 채널에 붙는다")는 여기 전이되지 않는다 — 그 논리의 근거가 "이미 내 글에 반응한 사람"이었다.

## 사용자 상태는 전부 `~/.crosspost`

`CROSSPOST_HOME` — `.env`(자격증명)·`voice.md`·`posts/`·`ledgers/`·`browser-profile/`·`follow-seeds.json`(explore 씨앗)·`cards.theme.json`(카드 테마 오버라이드)·`cards/`(카드 스펙)·`build/`(중간 프레임)·`media/`(발행용 `reel.mp4`/`card-NN.jpg`). 플러그인 설치본은 업데이트 시 교체되는 캐시 복사본이므로 상태를 그 안에 두면 안 된다.

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
