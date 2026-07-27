import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

const repo = fileURLToPath(new URL('..', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'crosspost-test-'));
const posts = join(home, 'posts');
const ledgers = join(home, 'ledgers');
mkdirSync(posts, { recursive: true });
mkdirSync(ledgers, { recursive: true });
const post = join(posts, '2026-07-27_contract.txt');
writeFileSync(post, 'Opening hook\n\nBody\n');

after(() => rmSync(home, { recursive: true, force: true }));

const run = (script, args, env = {}, nodeArgs = []) => spawnSync(
  process.execPath,
  [...nodeArgs, join(repo, script), ...args],
  {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, CROSSPOST_HOME: home, ...env },
  },
);

test('Threads --skip-done exits before any API request', () => {
  writeFileSync(
    join(ledgers, 'published-threads.json'),
    JSON.stringify([{ file: post, rootId: '1' }]),
  );
  const result = run(
    'scripts/threads/post-api.mjs',
    ['--skip-done', post],
    { THREADS_ACCESS_TOKEN: 'test', THREADS_USER_ID: 'test' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skip \(already published\)/);
});

test('Naver --skip-done exits before cookie or browser access', () => {
  writeFileSync(
    join(ledgers, 'published-naver.json'),
    JSON.stringify([{ slug: 'contract', logNo: '1' }]),
  );
  const result = run(
    'scripts/naver-blog/post-api.mjs',
    ['--skip-done', post],
    { NAVER_BLOG_ID: 'test' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skip \(already published\)/);
});

test('Brunch --skip-done exits before CDP access', () => {
  writeFileSync(
    join(ledgers, 'published-brunch.json'),
    JSON.stringify([{ file: basename(post), articleNo: '1' }]),
  );
  const result = run('scripts/brunch/post-api.mjs', ['--skip-done', post]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skip \(already published\)/);
});

test('Remember generic entrypoint honors --skip-done', () => {
  writeFileSync(
    join(ledgers, 'published-remember.jsonl'),
    `${JSON.stringify({ file: post, ts: new Date().toISOString() })}\n`,
  );
  const result = run(
    'scripts/remember/post-api.mjs',
    ['--skip-done', post],
    { DRY: '1' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skip \(already in ledger\)/);
});

test('LinkedIn stats returns an empty result for a fresh ledger', () => {
  rmSync(join(ledgers, 'published-linkedin.json'), { force: true });
  const result = run('scripts/linkedin/stats-fast.mjs', []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No LinkedIn posts yet/);
});

for (const channel of ['facebook', 'instagram']) {
  test(`${channel} delete preserves the ledger on API failure and prunes it on confirmation`, () => {
    const ledger = join(ledgers, `published-${channel}.json`);
    writeFileSync(ledger, JSON.stringify([{ id: 'target' }, { id: 'keep' }]));
    const env = channel === 'facebook'
      ? { FACEBOOK_PAGE_ID: 'page', FACEBOOK_PAGE_ACCESS_TOKEN: 'token' }
      : { IG_USER_ID: 'user', IG_ACCESS_TOKEN: 'token' };
    const preload = ['--import', join(repo, 'test-support/mock-fetch.mjs')];

    const failed = run(
      `scripts/${channel}/post-api.mjs`,
      ['--delete', 'target'],
      { ...env, MOCK_FETCH_STATUS: '400', MOCK_FETCH_BODY: '{"error":{"message":"denied"}}' },
      preload,
    );
    assert.equal(failed.status, 1);
    assert.deepEqual(JSON.parse(readFileSync(ledger, 'utf8')).map((entry) => entry.id), ['target', 'keep']);

    const succeeded = run(
      `scripts/${channel}/post-api.mjs`,
      ['--delete', 'target'],
      { ...env, MOCK_FETCH_STATUS: '200', MOCK_FETCH_BODY: '{"success":true}' },
      preload,
    );
    assert.equal(succeeded.status, 0, succeeded.stderr);
    assert.deepEqual(JSON.parse(readFileSync(ledger, 'utf8')).map((entry) => entry.id), ['keep']);
  });
}
