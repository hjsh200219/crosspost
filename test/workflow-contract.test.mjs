import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('Remember exposes the generic workflow entrypoints', () => {
  assert.equal(existsSync(new URL('../scripts/remember/post-api.mjs', import.meta.url)), true);
  assert.equal(existsSync(new URL('../scripts/remember/stats.mjs', import.meta.url)), true);
});

for (const channel of ['threads', 'naver-blog', 'brunch']) {
  test(`${channel} implements the workflow --skip-done contract`, () => {
    const code = source(`scripts/${channel}/post-api.mjs`);
    assert.match(code, /--skip-done/);
    assert.match(code, /skipDone|SKIP_DONE/);
  });
}

test('Facebook and Instagram deletes reject failed API responses', () => {
  for (const channel of ['facebook', 'instagram']) {
    const code = source(`scripts/${channel}/post-api.mjs`);
    assert.match(code, /if \(!r\.ok \|\| data\?\.error \|\| !confirmed\)/);
    assert.match(code, /filter\(\(entry\) => entry\.id !== delId\)/);
  }
});

test('batch publishers propagate partial failure through exitCode', () => {
  for (const channel of ['linkedin', 'threads', 'x']) {
    assert.match(source(`scripts/${channel}/post-api.mjs`), /process\.exitCode\s*=\s*1/);
  }
});

test('Instagram canonical-caption fallback preserves the opening line', () => {
  const publisher = source('scripts/instagram/post-api.mjs');
  const checker = source('scripts/instagram/check-cards.mjs');
  assert.doesNotMatch(publisher, /raw\.split\('\\n'\)\.slice\(1\)/);
  assert.doesNotMatch(checker, /raw\.split\('\\n'\)\.slice\(1\)/);
});

test('LinkedIn stats handles a missing ledger', () => {
  const code = source('scripts/linkedin/stats-fast.mjs');
  assert.match(code, /existsSync\(LEDGER\)/);
});

test('guided setup includes Instagram credentials', () => {
  const setup = source('commands/setup.md');
  const envExample = source('config/.env.example');
  assert.match(setup, /IG_USER_ID/);
  assert.match(setup, /IG_ACCESS_TOKEN/);
  assert.match(setup, /CROSSPOST_MEDIA_BASE_URL/);
  assert.match(envExample, /IG_USER_ID/);
  assert.match(envExample, /IG_ACCESS_TOKEN/);
});

test('publish ordering is ledger-local and Naver verifies document content', () => {
  const ordering = source('scripts/lib/publish-order.mjs');
  const naver = source('scripts/naver-blog/post-api.mjs');
  assert.doesNotMatch(ordering, /published-linkedin/);
  assert.doesNotMatch(ordering, /linkedinMs/);
  assert.match(source('scripts/facebook/post-api.mjs'), /publishedAt/);
  assert.match(naver, /documentSignature/);
  assert.match(naver, /JSON\.stringify\(actual\) !== JSON\.stringify\(expected\)/);
});
