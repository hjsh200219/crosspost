---
created: 2026-07-25T13:40:00+09:00
project: crosspost
summary: 네이버 블로그 태그 지원 추가 (v0.2.0). SE-ONE 태그 입력의 조용한 실패 2종 대응 포함.
---

## Session Digest

배포용 crosspost 플러그인의 네이버 블로그 발행기에 **태그 지원**을 추가했다(v0.1.0 → v0.2.0, 커밋 `4fa3d9f`).

네이버 블로그는 이 플러그인의 7개 채널 중 유일하게 태그 필드가 있는데 발행기가 그걸 전혀 채우지 않고 있었다. 원본 프로젝트(shconsulting)는 `insights.ts`의 `keywords[]`를 태그 소스로 쓰지만, 플러그인은 `extract-insight.mjs`를 배포하지 않아(insights.ts 결합) 그 경로를 그대로 복사할 수 없다. 그래서 플러그인 관용구(`.en.txt`, 커버 이미지와 같은 sibling 방식)에 맞춰 `<slug>.tags` 파일 + `--tags "a,b,c"` 플래그로 붙였다.

**SE-ONE 태그 입력에 조용한 실패가 두 개 있다**(실제 에디터로 확인, 2026-07-25):
1. **공백이 구분자다.** `AI 법률 상담`을 그대로 넣으면 `AI`/`법률`/`상담` 3개로 쪼개지고 그 뒤 키워드가 유실된다.
2. **특수문자는 입력이 거부되면서 뒤에 오는 태그까지 삼킨다.** `yt-dlp`를 넣으니 다음 태그 `vibecoding`이 통째로 사라졌다.

둘 다 에러 없이 실패한다. `toTags()`가 한글·영숫자만 남기고, `fillTags()`가 에디터에 실제로 확정된 칩 수를 세어 입력 수와 다르면 `*** MISMATCH ***`를 찍는다. 공백 제거는 부수적으로 검색 수요와도 맞다 — 네이버 키워드도구 실측에서 붙여쓴 `바이브코딩`이 월 34,900이다.

재발행 시 태그가 누적되지 않도록 `clearTags()`가 기존 칩을 먼저 지운다(빈 입력창에서 Backspace 반복).

## Progress

- [x] `--tags` 플래그 + `<slug>.tags` sibling 파일 지원
- [x] 발행·편집 경로 양쪽 배선
- [x] 공백·특수문자 함정 대응 + 확정 칩 수 검증
- [x] 기존 태그 제거(재실행 안전)
- [x] SKILL.md·README.md 문서화, v0.2.0 bump, 푸시
- [ ] 설치 캐시 갱신 (아래 Blockers)
- [ ] 실제 플러그인 설치본으로 스모크 테스트

## Next Steps

1. **설치 캐시 갱신** — `~/.claude/plugins/cache/crosspost`가 아직 v0.1.0이다. `plugin update`는 버전 bump만으로 안 먹은 전력이 있으니 **uninstall + reinstall**이 확실하다
2. **fresh-home 실설치 스모크** — 배포 플러그인은 syntax check + grep으로 불충분하다. 실제 설치해 네이버 발행 1건으로 태그가 붙는지 확인할 것
3. 다른 채널 태그 지원은 불필요 — 네이버만 태그 필드가 있다

## Blockers

- 플러그인 캐시가 구버전. 재설치 전까지 실제 사용 경로에는 태그가 안 붙는다

## Watch Out

- **`toTags()` 필터는 필요조건이지 충분조건이 아니다.** 실질 검증은 확정 칩 수 대조(`tags: N entered → N committed`)와 발행 후 `BlogTagListInfo.naver?blogId=..&logNoList=..&logType=mylog` 조회다
- 이 플러그인의 네이버 발행기는 shconsulting 쪽과 **입력 모델이 다르다**(평문 `.txt` vs insights slug). 한쪽을 고쳤다고 다른 쪽이 따라오지 않는다 — 이번에도 shconsulting만 고치고 여기를 빠뜨릴 뻔했다
- 태그 상한은 10개(`MAX_TAGS`). 네이버 자체 상한은 30개지만 상위 키워드만 의미가 있다

## Files Touched

- `scripts/naver-blog/post-api.mjs` — `toTags()`·`fillTags()`·`clearTags()`·`resolveTags()`, 발행/편집 경로 배선, `--tags` 인자
- `skills/publish/SKILL.md` — sibling 표에 `.tags` 추가 + 함정 설명
- `README.md` — sibling 파일 예시 + 태그 정규화 설명
- `.claude-plugin/plugin.json` — v0.1.0 → v0.2.0
