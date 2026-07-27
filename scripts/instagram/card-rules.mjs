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
// These are deliberately conservative — a card that overflows its box is unrecoverable once
// published, while a slightly short line costs nothing.
export const CAPS = {
  cover: { gate: 65, warn: 60 },
  stat: { gate: 65, warn: 60 },
  quote: { gate: 65, warn: 60 },
  body: { gate: 90, warn: 75 },
  checklist: { gate: 100, warn: 80 },
};

// Card counts. 10 is Instagram's carousel limit. The reels ceiling is about attention, not
// the platform: at ~4-6s per cut, 8 cards is already ~45s.
export const CNT = { carousel: [1, 10], reels: [3, 8] };

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
    errors.push(`${format}: ${cards.length} cards is outside the allowed ${min}–${max}`);
  }

  cards.forEach((card, i) => {
    const n = i + 1;
    if (!CARD_TYPES.includes(card.type)) {
      errors.push(`card ${n}: unknown type "${card.type}" (expected ${CARD_TYPES.join(' | ')})`);
      return;
    }
    const cap = CAPS[card.type];
    for (const line of textOf(card)) {
      if (typeof line !== 'string') { errors.push(`card ${n}: non-string text`); continue; }
      if (line.length > cap.gate) errors.push(`card ${n} (${card.type}): ${line.length} chars exceeds ${cap.gate} — "${line.slice(0, 30)}…"`);
      else if (line.length > cap.warn) warnings.push(`card ${n} (${card.type}): ${line.length} chars is over the comfortable ${cap.warn}`);
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
