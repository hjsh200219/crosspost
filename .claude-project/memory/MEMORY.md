# Project Memory — crosspost

이 플러그인 작업에서 반복해서 쓸모 있는 사실만 모은다. 코드나 git 히스토리로 알 수 있는 건 넣지 않는다.

- [naver-tag-input-traps](naver-tag-input-traps.md) — 네이버 태그 입력: 공백=구분자, 특수문자=뒤 태그까지 유실. 둘 다 무증상 실패라 확정 칩 수 대조 필수
- [browserless-transports](browserless-transports.md) — LinkedIn/네이버가 브라우저를 쓰던 이유는 서버엔 없다(SSR·CORS). li_at 하나만 보낼 것(전체 쿠키는 400), cbox는 서버 거부
- [instagram-channel-design](instagram-channel-design.md) — IG는 텍스트 발행 불가 + 공개 URL 페치 + 발행 후 수정 불가. 카드 생성기를 브랜드 걷어내고 다시 쓴 이유들
- [brunch-server-side-impossible](brunch-server-side-impossible.md) — 브런치 API는 브라우저 컨텍스트에만 인증. 쿠키 4조합·csrf 헤더 전부 401(재시도 낭비 방지)
- [ledger-local-publish-ordering](ledger-local-publish-ordering.md) — 통계 정렬 시 다른 채널 장부의 시각을 빌리지 않고 각 채널 장부의 `publishedAt`/`ts`를 사용
- [naver-ui-dialog-autoaccept](naver-ui-dialog-autoaccept.md) — 네이버 UI 경로는 오류 alert를 자동 수락해 거부가 예외로 안 온다. 성공 판정은 URL로만
