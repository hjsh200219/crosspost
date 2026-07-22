// 발행 시각 정렬 헬퍼 — 조회 결과를 날짜+시간 역순(최신 먼저)으로 정렬한다.
//
// 채널마다 장부에 담긴 시각 정보가 다르다:
//   - LinkedIn: urn 스노플레이크에 발행 ms가 인코딩됨 (epoch offset 0, 실측 검증)
//   - Threads(publishedAt) · 브런치(ts) · X(ts) · 리멤버(ts): full ISO 보유
//   - Facebook · 네이버: date(YYYY-MM-DD)만 → LinkedIn 장부에서 file/slug 매칭해 시각 차용
//
// publishMs()가 위 우선순위로 각 row의 정렬용 ms를 반환한다. 정렬은:
//   rows.sort((a, b) => publishMs(b) - publishMs(a))
import { readFileSync } from 'node:fs';
import { dataPath } from './env.mjs';

// Cross-agent contract with the LinkedIn channel: its published ledger
// lives at dataPath('ledgers/published-linkedin.json'). Missing on a fresh
// install (nothing published yet) — liMap() below catches that and callers
// fall back to date-only sort instead of throwing.
const LI_LEDGER = dataPath('ledgers/published-linkedin.json');

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

let _liMap = null;
function liMap() {
  if (_liMap) return _liMap;
  _liMap = new Map();
  try {
    const d = JSON.parse(readFileSync(LI_LEDGER, 'utf8'));
    const arr = Array.isArray(d) ? d : d.posts || Object.values(d);
    for (const e of arr) {
      const ms = urnMs(e.urn);
      if (!Number.isFinite(ms)) continue;
      const key = slugOf(e.file);
      if (key) _liMap.set(key, ms);
    }
  } catch {
    /* 장부 없으면 빈 맵 → date 폴백 */
  }
  return _liMap;
}

// slug/file로 LinkedIn 발행 ms 차용 (Facebook·네이버용). 없으면 NaN.
export function linkedinMs(fileOrSlug) {
  const key = slugOf(fileOrSlug);
  const m = key ? liMap().get(key) : undefined;
  return Number.isFinite(m) ? m : NaN;
}

// row에서 정렬용 ms 해석: ts > publishedAt > urn > LinkedIn 차용(file/slug) > date > 0
export function publishMs(row = {}) {
  const { ts, publishedAt, urn, file, slug, date } = row;
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
  const borrowed = linkedinMs(slug || file);
  if (Number.isFinite(borrowed)) return borrowed;
  if (date) {
    const t = Date.parse(date);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}
