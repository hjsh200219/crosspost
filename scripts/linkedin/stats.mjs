#!/usr/bin/env node
// DEPRECATED — back-compat shim. The real engine is stats-fast.mjs.
//
// stats.mjs used to scrape the first .feed-shared-update-v2 card on /feed/update/<urn>/.
// On SPA re-navigation LinkedIn can leave a prior post's card or render a suggested card
// first, so impressions got attached to the WRONG post — values drifted vs the title and
// duplicated across runs (totals 1123/830/977 disagreed, 2026-06-28). That scrape logic is
// gone. All invocations now forward verbatim to stats-fast.mjs, which loads each post's own
// /analytics/post-summary/<activityUrn>/ page (structurally immune to cross-card mixups) and
// also covers --all discovery and --account routing. Kept only so existing `node stats.mjs`
// callers (README, cron, muscle memory) keep working and get correct numbers.
//
// Prefer calling stats-fast.mjs directly.
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
process.stderr.write('[stats.mjs] deprecated → forwarding to stats-fast.mjs (use it directly)\n');

const child = spawn(process.execPath, [join(here, 'stats-fast.mjs'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
