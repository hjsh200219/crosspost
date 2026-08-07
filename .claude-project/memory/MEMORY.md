# Project Memory — crosspost

이 플러그인 작업에서 반복해서 쓸모 있는 사실만 모은다. 코드나 git 히스토리로 알 수 있는 건 넣지 않는다.

- [naver-tag-input-traps](naver-tag-input-traps.md) — 네이버 태그 입력: 공백=구분자, 특수문자=뒤 태그까지 유실. 둘 다 무증상 실패라 확정 칩 수 대조 필수
- [browserless-transports](browserless-transports.md) — LinkedIn/네이버가 브라우저를 쓰던 이유는 서버엔 없다(SSR·CORS). li_at 하나만 보낼 것(전체 쿠키는 400), cbox는 서버 거부
- [instagram-channel-design](instagram-channel-design.md) — IG는 텍스트 발행 불가 + 공개 URL 페치 + 발행 후 수정 불가. 카드 생성기를 브랜드 걷어내고 다시 쓴 이유들. 렌더 실측 게이트가 있어야 앞단 글자 상한을 풀 수 있다
- [brunch-server-side-impossible](brunch-server-side-impossible.md) — 브런치 인증은 엔드포인트마다 갈린다: /v2/me·통계=브라우저 전용, 구독 목록=공개, 라이킷=curl_cffi 기본 전송만(impersonate 켜면 401)
- [follow-tooling-contracts](follow-tooling-contracts.md) — 팔로우 계약 6종: 장부 상태 4종(followed만 팔로우)·게이트는 코드에·DOM 라벨 번역 금지·같은 채널 모드는 순차·새 모드는 fail-closed·콜드 아웃리치는 다른 위험 등급
- [dry-run-touches-live-sessions](dry-run-touches-live-sessions.md) — CDP 세션이 살아 있으면 --dry-run도 실계정을 읽고 격리 홈에 세션 쿠키가 남는다(검증 후 삭제)
- [upstream-sync-content-drift](upstream-sync-content-drift.md) — 원본 역동기화의 본체는 없는 파일이 아니라 공유 파일의 내용 드리프트. 동기화 기준 커밋을 남기고, 상수는 값이 아니라 측정 의미론과 함께 옮길 것
- [ledger-local-publish-ordering](ledger-local-publish-ordering.md) — 통계 정렬 시 다른 채널 장부의 시각을 빌리지 않고 각 채널 장부의 `publishedAt`/`ts`를 사용
- [naver-ui-dialog-autoaccept](naver-ui-dialog-autoaccept.md) — 네이버 UI 경로는 오류 alert를 자동 수락해 거부가 예외로 안 온다. 성공 판정은 URL로만
- [npm-pack-ignores-gitignore](npm-pack-ignores-gitignore.md) — `files`를 넣으면 npm이 `.gitignore`를 안 본다. 발행 감사는 소스 트리가 아니라 `npm pack` tarball에서
