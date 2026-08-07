/**
 * Card-spec predicates — the SINGLE SOURCE OF TRUTH for what a valid card set looks like.
 *
 * Both the generator (gen-cards.mjs) and the pre-publish gate (check-cards.mjs) import this
 * file. Keeping the rules in one place is not tidiness: when a generator and a checker each
 * carry their own copy of a limit, they drift, and the limit stops being enforced at exactly
 * the moment it matters. Instagram cannot replace media after publishing, so the last chance
 * to catch a bad card is before the container is created.
 */

// Per-type character caps. `gate` fails the check; `warn` is the comfortable target.
//
// The caps are measured two different ways, because the cards are built two different ways:
//
//   body / checklist   PER CARD — heading, text and every item share one budget. These types
//                      stack lines in the same box, so capping each line separately lets a
//                      four-item checklist carry four times the text of a one-item one while
//                      both "pass".
//   cover / stat / quote   PER LINE — one dominant element (an 84px headline, a 180px number,
//                      a 62px pull quote) plus a short secondary. There is no stack to sum.
//
// body/checklist were raised from 90/100 (per line) to 130/160 (per card): the old numbers made
// cards that could only list bullets, with no room to explain them. Overflow is still caught for
// real by gen-cards.mjs, which measures `scrollHeight - clientHeight` in the page and refuses to
// write a clipped render — these caps are the earlier, cheaper gate, not the only one.
export const CAPS = {
  cover: { gate: 65, warn: 60 },
  stat: { gate: 65, warn: 60 },
  quote: { gate: 65, warn: 60 },
  body: { gate: 130, warn: 105 },
  checklist: { gate: 160, warn: 130 },
};

/** Types whose cap is the card total rather than a per-line limit (see CAPS). */
const BUDGETED = new Set(['body', 'checklist']);

/** What the per-card budget actually counts — quoted back in the error so the author knows
 *  which field to shorten. "over 130" alone sends people to trim the wrong line. */
const BUDGET_FIELDS = {
  body: 'heading + text + all items',
  checklist: 'heading + all items',
};

// Card counts. 10 is Instagram's carousel limit — the platform's number, not ours.
// Reels have no ceiling: card count is a poor proxy for length, because a cut lasts as long as
// its text takes to read (or its narration to speak), not as long as a fixed slot. The lower
// bound stays — it is a quality floor, not a cap.
export const CNT = { carousel: [1, 10], reels: [4, Infinity] };

export const EYEBROW_MAX = 24;   // small label above the headline
export const SUBJECT_MAX = 19;   // short subject shown in the corner rail

// Caption length. 2,200 is the platform limit (gate). The warn threshold exists because the
// feed truncates at roughly 125 characters — everything past that is only read by people who
// tapped "more", so a 1,500-character caption is mostly unread weight.
export const CAPTION = { gate: 2200, warn: 850, target: [600, 850] };

export const CARD_TYPES = ['cover', 'stat', 'body', 'checklist', 'quote'];

const textOf = (card) => {
  switch (card.type) {
    case 'cover': return [card.headline, card.eyebrow, card.subject].filter(Boolean);
    case 'stat': return [card.value, card.label, card.note].filter(Boolean);
    case 'quote': return [card.quote, card.attribution].filter(Boolean);
    case 'body': return [card.heading, ...(card.items || []), card.text].filter(Boolean);
    case 'checklist': return [card.heading, ...(card.items || [])].filter(Boolean);
    default: return [];
  }
};

/** Characters a budgeted card spends. `subject` is excluded — it renders in the footer, outside
 *  the content box the budget is about, and it has its own SUBJECT_MAX. */
const budgetLines = (card) => (card.type === 'checklist'
  ? [card.heading, ...(card.items || [])]
  : [card.heading, card.text, ...(card.items || [])]).filter((v) => typeof v === 'string');

const budgetLen = (card) => budgetLines(card).join(' ').length;

/** Per-field spend, so an over-budget card says where the characters went. */
const breakdown = (card) => {
  const parts = [];
  if (card.heading) parts.push(`heading ${String(card.heading).length}`);
  if (card.type !== 'checklist' && card.text) parts.push(`text ${String(card.text).length}`);
  if (card.items?.length) parts.push(`${card.items.length} items ${card.items.join(' ').length}`);
  return parts.join(' + ');
};

/**
 * Validate a card spec. Returns { errors, warnings } — errors block publishing.
 * `format` is 'carousel' | 'reels'.
 */
export function validate(spec, { format = 'carousel' } = {}) {
  const errors = [];
  const warnings = [];

  if (!spec || typeof spec !== 'object') return { errors: ['spec is not an object'], warnings };
  const cards = Array.isArray(spec.cards) ? spec.cards : null;
  if (!cards) return { errors: ['spec.cards must be an array'], warnings };

  const [min, max] = CNT[format] || CNT.carousel;
  if (cards.length < min || cards.length > max) {
    const range = Number.isFinite(max) ? `${min}–${max}` : `${min} or more`;
    errors.push(`${format}: ${cards.length} cards is outside the allowed ${range}`);
  }

  cards.forEach((card, i) => {
    const n = i + 1;
    if (!CARD_TYPES.includes(card.type)) {
      errors.push(`card ${n}: unknown type "${card.type}" (expected ${CARD_TYPES.join(' | ')})`);
      return;
    }
    const cap = CAPS[card.type];
    const lines = textOf(card);
    for (const line of lines) {
      if (typeof line !== 'string') errors.push(`card ${n}: non-string text`);
    }
    if (BUDGETED.has(card.type)) {
      // One budget for the whole card — see CAPS. Naming the fields matters: told only
      // "over 130", an author trims the heading when the items are what overflowed.
      const len = budgetLen(card);
      if (len > cap.gate) {
        errors.push(`card ${n} (${card.type}): ${len} chars exceeds ${cap.gate} for the card — the budget is ${BUDGET_FIELDS[card.type]} (${breakdown(card)})`);
      } else if (len > cap.warn) {
        warnings.push(`card ${n} (${card.type}): ${len} chars is over the comfortable ${cap.warn} for the card (${breakdown(card)})`);
      }
    } else {
      for (const line of lines) {
        if (typeof line !== 'string') continue;
        if (line.length > cap.gate) errors.push(`card ${n} (${card.type}): ${line.length} chars exceeds ${cap.gate} — "${line.slice(0, 30)}…"`);
        else if (line.length > cap.warn) warnings.push(`card ${n} (${card.type}): ${line.length} chars is over the comfortable ${cap.warn}`);
      }
    }
    if (card.eyebrow && card.eyebrow.length > EYEBROW_MAX) errors.push(`card ${n}: eyebrow exceeds ${EYEBROW_MAX} chars`);
    if (card.subject && card.subject.length > SUBJECT_MAX) errors.push(`card ${n}: subject exceeds ${SUBJECT_MAX} chars`);
    if ((card.type === 'body' || card.type === 'checklist') && !(card.items?.length || card.text)) {
      errors.push(`card ${n} (${card.type}): needs items[] or text`);
    }
    if (card.type === 'stat' && !card.value) errors.push(`card ${n} (stat): needs a value`);
    if (card.type === 'quote' && !card.quote) errors.push(`card ${n} (quote): needs a quote`);
    if (card.type === 'cover' && !card.headline) errors.push(`card ${n} (cover): needs a headline`);
  });

  if (cards[0] && cards[0].type !== 'cover') warnings.push('card 1 is usually a cover — it is the only card most people see');

  return { errors, warnings };
}

/** Validate a caption string. Same return shape. */
export function validateCaption(caption, { canonicalUrl = null } = {}) {
  const errors = [];
  const warnings = [];
  const text = String(caption || '').trim();
  if (!text) return { errors: ['caption is empty'], warnings };
  if (text.length > CAPTION.gate) errors.push(`caption is ${text.length} chars, over Instagram's ${CAPTION.gate}`);
  else if (text.length > CAPTION.warn) warnings.push(`caption is ${text.length} chars; ${CAPTION.target[0]}–${CAPTION.target[1]} reads better (the feed truncates near 125)`);
  // A caption URL is not clickable on Instagram, but writing the address out is the only path
  // from the post to the full article — the cards carry no domain either.
  if (canonicalUrl && !text.includes(canonicalUrl.replace(/^https?:\/\//, '').split('?')[0])) {
    warnings.push('caption does not spell out the canonical URL — that address is the only route to the full post');
  }
  return { errors, warnings };
}
