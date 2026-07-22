#!/usr/bin/env node
// Scheduled-publish worker for the LinkedIn queue (entries created by `post-api.mjs --at`).
// Run this periodically via your own cron/launchd (e.g. every 10 minutes).
//
//   node scheduler.mjs          # publish due entries, post first comments
//   node scheduler.mjs --list   # print queue (human-readable)
//
// Failure policy: 3 attempts per entry, then moved to the queue log with status=failed.
// Token expiry is detected up front (logged, no attempts consumed).
// Schedules LinkedIn only; for 7-channel fan-out publish immediately via the skill.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { dataPath } from '../lib/env.mjs';
import { loadEnv } from './account.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
process.chdir(DIR);

const QUEUE = dataPath('ledgers/queue-linkedin.json');
const LOG = dataPath('ledgers/queue-log-linkedin.jsonl'); // publish/failure history: {ts, file, when, status, urn?, error?}
const MAX_ATTEMPTS = 3;

function loadQueue() {
  return existsSync(QUEUE) ? JSON.parse(readFileSync(QUEUE, 'utf8')) : [];
}
function saveQueue(q) {
  writeFileSync(QUEUE, JSON.stringify(q, null, 2) + '\n');
}
function logEntry(e) {
  appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');
}
function titleOf(file) {
  try { return readFileSync(file, 'utf8').trim().split('\n')[0].trim().slice(0, 60); } catch { return file; }
}

if (process.argv[2] === '--list') {
  const q = loadQueue();
  if (!q.length) { console.log('queue is empty'); process.exit(0); }
  for (const e of q) {
    console.log(`${e.when}  ${titleOf(e.file)}  [${e.account || 'default'}]\n  file: ${e.file}${e.comment ? '\n  comment: ' + e.comment : ''}${e.attempts ? `\n  attempts: ${e.attempts} (last error: ${e.lastError || '-'})` : ''}`);
  }
  process.exit(0);
}

const q = loadQueue();
const due = q.filter((e) => new Date(e.when) <= new Date());
if (!due.length) process.exit(0);

// Per-account token expiry check — an expired account is retried on the next run
// without consuming an attempt.
const expiredNotified = new Set();
function tokenExpired(account) {
  const exp = parseInt(loadEnv(account).pick('LINKEDIN_TOKEN_EXPIRES') || '0', 10);
  return exp && Date.now() / 1000 > exp;
}

for (const e of due) {
  const idx = q.indexOf(e);
  const account = e.account || 'default'; // older queue entries (no account) default to 'default'
  const acctArgs = account === 'default' ? [] : ['--account', account];

  if (tokenExpired(account)) {
    if (!expiredNotified.has(account)) {
      expiredNotified.add(account);
      console.error(`[linkedin-scheduler] token expired (account ${account}) — entries waiting in queue. Re-auth: node auth.mjs${account === 'default' ? '' : ` --account ${account}`}`);
    }
    continue; // retried on the next run without consuming an attempt
  }

  try {
    const out = execFileSync(process.execPath, ['post-api.mjs', ...acctArgs, e.file], { encoding: 'utf8', timeout: 60000 });
    const urn = (out.match(/urn:li:share:\d+/) || [])[0];
    if (!urn) throw new Error(`failed to parse URN: ${out.slice(0, 200)}`);
    let commentNote = '';
    if (e.comment) {
      try {
        execFileSync(process.execPath, ['comment-api.mjs', ...acctArgs, urn, e.comment], { encoding: 'utf8', timeout: 60000 });
        commentNote = ' +comment';
      } catch (ce) {
        commentNote = ` (comment failed: ${ce.message.slice(0, 80)})`;
      }
    }
    q.splice(idx, 1);
    logEntry({ file: e.file, when: e.when, account, status: 'published', urn });
    console.log(`[linkedin-scheduler] (${account}) published${commentNote}: ${titleOf(e.file)} ${urn}`);
  } catch (err) {
    e.attempts = (e.attempts || 0) + 1;
    e.lastError = err.message.slice(0, 200);
    if (e.attempts >= MAX_ATTEMPTS) {
      q.splice(idx, 1);
      logEntry({ file: e.file, when: e.when, account, status: 'failed', error: e.lastError });
      console.error(`[linkedin-scheduler] (${account}) gave up after ${MAX_ATTEMPTS} attempts: ${e.file}\n${e.lastError}`);
    }
  }
}
saveQueue(q);
