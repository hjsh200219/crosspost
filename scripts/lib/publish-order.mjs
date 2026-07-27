// 발행 시각 정렬 헬퍼 — 조회 결과를 날짜+시간 역순(최신 먼저)으로 정렬한다.
//
// 채널마다 장부에 담긴 시각 정보가 다르다:
//   - LinkedIn: urn 스노플레이크에 발행 ms가 인코딩됨 (epoch offset 0, 실측 검증)
//   - Threads(publishedAt) · 브런치(ts) · X(ts) · 리멤버(ts): full ISO 보유
//   - Facebook · 네이버: publishedAt (신규 장부) 또는 date(기존 장부)
//
// 각 채널은 자기 장부의 시각만 사용한다. 다른 채널 장부에서 시각을 빌리면
// LinkedIn 다중 계정처럼 저장소가 둘 이상일 때 숨은 전역 결합이 생긴다.
// publishMs()가 위 우선순위로 각 row의 정렬용 ms를 반환한다. 정렬은:
//   rows.sort((a, b) => publishMs(b) - publishMs(a))

// LinkedIn/Twitter 스타일 스노플레이크 → 발행 ms (epoch offset 0)
export function urnMs(urn) {
  try {
    const id = BigInt(String(urn).split(':').pop());
    const ms = Number(id >> 22n);
    return Number.isFinite(ms) && ms > 0 ? ms : NaN;
  } catch {
    return NaN;
  }
}

// "posts/2026-07-13_lawyer-ai-agent.txt" | "2026-07-13_lawyer-ai-agent.txt" | "lawyer-ai-agent" → "lawyer-ai-agent"
export function slugOf(fileOrSlug) {
  if (!fileOrSlug) return '';
  const base = String(fileOrSlug).split('/').pop().replace(/\.txt$/, '');
  return base.replace(/^\d{4}-\d{2}-\d{2}_/, '');
}

// row에서 정렬용 ms 해석: ts > publishedAt > urn > date > 0
export function publishMs(row = {}) {
  const { ts, publishedAt, urn, date } = row;
  if (ts) {
    const t = Date.parse(ts);
    if (Number.isFinite(t)) return t;
  }
  if (publishedAt) {
    const t = Date.parse(publishedAt);
    if (Number.isFinite(t)) return t;
  }
  if (urn) {
    const t = urnMs(urn);
    if (Number.isFinite(t)) return t;
  }
  if (date) {
    const t = Date.parse(date);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}
