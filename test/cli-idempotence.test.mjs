import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
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

test('Brunch --skip-done fails closed when its ledger is malformed', () => {
  writeFileSync(join(ledgers, 'published-brunch.json'), '{not-json');
  const result = run('scripts/brunch/post-api.mjs', ['--skip-done', post]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot read Brunch ledger/);
  assert.doesNotMatch(result.stderr, /connectOverCDP/);
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

test('X --skip-done fails closed when its ledger is malformed', () => {
  writeFileSync(join(ledgers, 'published-x.json'), '{not-json');
  const result = run(
    'scripts/x/post-api.mjs',
    ['--skip-done', post],
    {
      X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_SECRET: 'ts',
      MOCK_FETCH_STATUS: '500', MOCK_FETCH_BODY: '{}',
    },
    ['--import', join(repo, 'test-support/mock-fetch.mjs')],
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot read X ledger/);
  // fail-closed: 손상된 장부 파일은 덮어쓰지 않고 그대로 남는다
  assert.equal(readFileSync(join(ledgers, 'published-x.json'), 'utf8'), '{not-json');
});

test('Remember --skip-done fails closed when its ledger is malformed', () => {
  writeFileSync(join(ledgers, 'published-remember.jsonl'), '{not-json\n');
  const result = run(
    'scripts/remember/post-api.mjs',
    ['--skip-done', post],
    { DRY: '1' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot read Remember ledger/);
});

test('LinkedIn --at stores an absolute file path for the scheduler', () => {
  const queue = join(ledgers, 'queue-linkedin.json');
  rmSync(queue, { force: true });
  // scheduler.mjs가 자기 디렉터리로 chdir한 뒤 spawn하므로, 상대경로로 enqueue해도
  // 큐에는 절대경로가 저장되어야 발행 시점 ENOENT가 나지 않는다.
  const result = spawnSync(
    process.execPath,
    [join(repo, 'scripts/linkedin/post-api.mjs'), '--at', '2099-01-01 09:00', join('posts', basename(post))],
    {
      cwd: home,
      encoding: 'utf8',
      env: {
        ...process.env,
        CROSSPOST_HOME: home,
        LINKEDIN_ACCESS_TOKEN: 'test',
        LINKEDIN_PERSON_URN: 'urn:li:person:test',
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const [entry] = JSON.parse(readFileSync(queue, 'utf8'));
  assert.ok(isAbsolute(entry.file), `queued path is not absolute: ${entry.file}`);
  assert.equal(basename(entry.file), basename(post));
});

test('Brunch --skip-done does not treat a draft entry as published', () => {
  writeFileSync(
    join(ledgers, 'published-brunch.json'),
    JSON.stringify([{ file: basename(post), articleNo: '1', status: 'draft' }]),
  );
  // 초안은 publish 실행을 만족시키지 않아야 한다 — 만족시키면 승격할 길이 사라진다.
  // CDP에 닿기 전 다른 이유로 죽더라도, "이미 발행됨"으로 조기 종료하지 않는 것이 계약이다.
  const result = run('scripts/brunch/post-api.mjs', ['--skip-done', post]);
  assert.doesNotMatch(result.stdout, /skip \(already/);

  // 같은 초안을 --status draft로 다시 돌리면 그때는 건너뛴다
  const asDraft = run('scripts/brunch/post-api.mjs', ['--skip-done', '--status', 'draft', post]);
  assert.equal(asDraft.status, 0, asDraft.stderr);
  assert.match(asDraft.stdout, /skip \(already drafted\)/);
});

test('X stats fails closed on a corrupt ledger instead of reporting no posts', () => {
  writeFileSync(join(ledgers, 'published-x.json'), '{not-json');
  const result = run(
    'scripts/x/stats.mjs',
    [],
    { X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_SECRET: 'ts' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot read X ledger/);
  assert.doesNotMatch(result.stdout, /No X posts yet/);
});

test('LinkedIn --at rejects an explicit --image instead of dropping it', () => {
  const result = spawnSync(
    process.execPath,
    [join(repo, 'scripts/linkedin/post-api.mjs'), '--image', join(home, 'cover.jpg'), '--at', '2099-01-01 09:00', post],
    {
      cwd: home,
      encoding: 'utf8',
      env: {
        ...process.env,
        CROSSPOST_HOME: home,
        LINKEDIN_ACCESS_TOKEN: 'test',
        LINKEDIN_PERSON_URN: 'urn:li:person:test',
      },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--image is not supported with --at/);
});

test('Threads delete prunes the ledger only after the API confirms', () => {
  const ledger = join(ledgers, 'published-threads.json');
  writeFileSync(ledger, JSON.stringify([{ rootId: 'target', ids: ['target'] }, { rootId: 'keep', ids: ['keep'] }]));
  const env = { THREADS_ACCESS_TOKEN: 'test', THREADS_USER_ID: 'test' };
  const preload = ['--import', join(repo, 'test-support/mock-fetch.mjs')];

  const failed = run(
    'scripts/threads/post-api.mjs',
    ['--delete', 'target'],
    { ...env, MOCK_FETCH_STATUS: '500', MOCK_FETCH_BODY: '{"error":"denied"}' },
    preload,
  );
  assert.notEqual(failed.status, 0);
  assert.deepEqual(JSON.parse(readFileSync(ledger, 'utf8')).map((e) => e.rootId), ['target', 'keep']);

  const succeeded = run(
    'scripts/threads/post-api.mjs',
    ['--delete', 'target'],
    { ...env, MOCK_FETCH_STATUS: '200', MOCK_FETCH_BODY: '{"success":true}' },
    preload,
  );
  assert.equal(succeeded.status, 0, succeeded.stderr);
  assert.deepEqual(JSON.parse(readFileSync(ledger, 'utf8')).map((e) => e.rootId), ['keep']);
});

test('Facebook stats surfaces Graph errors instead of zero rows', () => {
  writeFileSync(
    join(ledgers, 'published-facebook.json'),
    JSON.stringify([{ id: 'dead', publishedAt: '2026-07-01T00:00:00.000Z' }]),
  );
  const result = run(
    'scripts/facebook/stats.mjs',
    [],
    {
      FACEBOOK_PAGE_ACCESS_TOKEN: 'token',
      MOCK_FETCH_STATUS: '400',
      MOCK_FETCH_BODY: '{"error":{"message":"denied","code":100}}',
    },
    ['--import', join(repo, 'test-support/mock-fetch.mjs')],
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| dead \|/);
  assert.match(result.stdout, /— \| — \| — \| —/);
  assert.match(result.stderr, /denied/);
});

test('Facebook stats fails loudly on an invalid token (error 190)', () => {
  writeFileSync(join(ledgers, 'published-facebook.json'), JSON.stringify([{ id: 'dead' }]));
  const result = run(
    'scripts/facebook/stats.mjs',
    [],
    {
      FACEBOOK_PAGE_ACCESS_TOKEN: 'token',
      MOCK_FETCH_STATUS: '400',
      MOCK_FETCH_BODY: '{"error":{"message":"Session expired","code":190}}',
    },
    ['--import', join(repo, 'test-support/mock-fetch.mjs')],
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /error 190/);
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
