import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { canonicalLink, slugFromFile } from '../scripts/lib/canonical-link.mjs';
import { publishMs, slugOf, urnMs } from '../scripts/lib/publish-order.mjs';
import { measuredTotal } from '../scripts/lib/totals.mjs';
import { validate, validateCaption } from '../scripts/instagram/card-rules.mjs';
import { buildDocumentModel, documentSignature } from '../scripts/naver-blog/http-publish.mjs';

test('canonical slugs strip date and channel variants', () => {
  assert.equal(slugFromFile('posts/2026-07-27_example.threads.txt'), 'example');
  process.env.CANONICAL_BASE_URL = 'https://example.test/posts/';
  assert.equal(canonicalLink('posts/2026-07-27_example.en.txt'), 'https://example.test/posts/example');
  delete process.env.CANONICAL_BASE_URL;
});

test('publish ordering prefers local timestamps and falls back to dates', () => {
  assert.equal(slugOf('posts/2026-07-27_example.txt'), 'example');
  assert.equal(Number.isFinite(urnMs('urn:li:share:7340000000000000000')), true);
  assert.equal(publishMs({ publishedAt: '2026-07-27T10:00:00Z' }), Date.parse('2026-07-27T10:00:00Z'));
  assert.equal(publishMs({ date: '2026-07-27' }), Date.parse('2026-07-27'));
});

test('Instagram validation rejects invalid cards and oversized captions', () => {
  assert.ok(validate({ cards: [{ type: 'cover' }] }).errors.length);
  assert.ok(validateCaption('x'.repeat(2201)).errors.length);
});

test('Naver document model contains title, body, heading, and trailer components', () => {
  const model = buildDocumentModel({
    title: 'Title',
    body: 'Body\n\n## Heading',
    trailer: 'Read: https://example.test',
  });
  assert.deepEqual(
    model.document.components.map((component) => component['@ctype']),
    ['documentTitle', 'text', 'sectionTitle', 'horizontalLine', 'text'],
  );
  const signature = documentSignature(model.document.components);
  assert.deepEqual(signature.map((component) => component.text.join(' ')), [
    'Title',
    'Body',
    'Heading',
    '',
    'Read: https://example.test',
  ]);
  const changed = structuredClone(model.document.components);
  changed[1].value[0].nodes[0].value = 'Changed';
  assert.notDeepEqual(documentSignature(changed), signature);
});

test('stats totals sum only measured cells and report their coverage', () => {
  const full = [{ views: 3 }, { views: 4 }];
  assert.equal(measuredTotal(full, 'views'), '7');
  // a `—` cell must neither count as 0 nor vanish silently from the total's meaning
  const partial = [{ views: 3 }, { views: null }, { views: 4 }];
  assert.equal(measuredTotal(partial, 'views'), '7 (2/3 measured)');
  // the case the rule exists for: every read failed. "0" alone would read as "measured zero".
  assert.equal(measuredTotal([{ views: null }, { views: null }], 'views'), '0 (0/2 measured)');
  // a measured zero is still a zero, with full coverage
  assert.equal(measuredTotal([{ views: 0 }, { views: 0 }], 'views'), '0');
});

test('follow ledger dedup, cap, and dry-run contracts hold', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'crosspost-follow-'));
  const prevHome = process.env.CROSSPOST_HOME;
  process.env.CROSSPOST_HOME = homeDir;
  try {
    const { runFollows, followedIds, blockedIds, ledgerPath } = await import('../scripts/lib/follow-core.mjs');
    const candidates = [
      { targetId: '1', handle: 'a' },
      { targetId: '2', handle: 'b' },
      { targetId: '2', handle: 'b-dup' },
      { targetId: '3', handle: 'c' },
    ];
    const opts = { channel: 'x', via: 'follow-back', delayMin: 0, delayMax: 0, describe: (c) => c.handle };

    // dry-run previews without following anyone and without leaving a trace a later real run
    // would read as "already done".
    const dry = await runFollows({ ...opts, candidates, dryRun: true, max: 10, follow: async () => { throw new Error('dry-run must not follow'); } });
    assert.equal(dry.followed, 0);
    assert.equal(existsSync(ledgerPath('x')), false);

    // the in-batch duplicate is dropped, and the cap truncates rather than silently dropping
    const followed = [];
    const real = await runFollows({ ...opts, candidates, dryRun: false, max: 2, follow: async (id) => { followed.push(id); } });
    assert.deepEqual(followed, ['1', '2']);
    assert.equal(real.skippedDedup, 1);
    assert.equal(real.capped, 1);

    // a second run skips what is already recorded as followed
    const again = [];
    await runFollows({ ...opts, candidates, dryRun: false, max: 10, follow: async (id) => { again.push(id); } });
    assert.deepEqual(again, ['3']);

    // blocked is recorded separately and never counts as followed
    await runFollows({
      ...opts, candidates: [{ targetId: '9', handle: 'refused' }], dryRun: false, max: 1,
      follow: async () => { const e = new Error('405'); e.blocked = true; throw e; },
    });
    assert.equal(followedIds('x').has('9'), false);
    assert.equal(blockedIds('x').has('9'), true);
  } finally {
    if (prevHome === undefined) delete process.env.CROSSPOST_HOME; else process.env.CROSSPOST_HOME = prevHome;
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('a partial delay flag cannot invert the follow delay range', async () => {
  const { parseFollowArgs } = await import('../scripts/lib/follow-core.mjs');
  // Threads-style defaults; only --delay-min is given, above the default max.
  const a = parseFollowArgs(['node', 'follow.mjs', '--follow-back', '--delay-min', '400'], { max: 3, delayMin: 90, delayMax: 300 });
  assert.equal(a.delayMin, 400);
  assert.ok(a.delayMax >= a.delayMin, 'an inverted range would collapse the wait to zero');
  // Explicit flags still win when they are consistent.
  const b = parseFollowArgs(['node', 'follow.mjs', '--follow-back', '--max', '2', '--delay-min', '5', '--delay-max', '10'], { max: 3, delayMin: 90, delayMax: 300 });
  assert.deepEqual([b.max, b.delayMin, b.delayMax], [2, 5, 10]);
});
