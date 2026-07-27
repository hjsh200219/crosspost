import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalLink, slugFromFile } from '../scripts/lib/canonical-link.mjs';
import { publishMs, slugOf, urnMs } from '../scripts/lib/publish-order.mjs';
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
