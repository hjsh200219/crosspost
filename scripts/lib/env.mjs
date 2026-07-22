// Shared environment + data-home helper for all crosspost channel scripts.
//
// All user state lives OUTSIDE the plugin install directory (Claude Code plugin
// installs are cache copies that get replaced on update):
//
//   $CROSSPOST_HOME (default: ~/.crosspost)
//   ├── .env                      # channel credentials (user-created, chmod 600)
//   ├── voice.md                  # user's brand voice guide (copied from config/voice.example.md)
//   ├── posts/                    # canonical post files + per-channel variants
//   ├── ledgers/                  # published-<channel>.json ledgers
//   └── browser-profile/          # persistent Chromium profile for CDP channels
//
// Usage:
//   import { loadEnv, home, dataPath, cdpPort } from '../lib/env.mjs'
//   loadEnv()                                   // merges $CROSSPOST_HOME/.env into process.env
//   const ledger = dataPath('ledgers/published-x.json')

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export function home() {
  return process.env.CROSSPOST_HOME || path.join(os.homedir(), '.crosspost')
}

/** Resolve a path under the data home, creating parent directories. */
export function dataPath(rel) {
  const p = path.join(home(), rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  return p
}

/** Parse $CROSSPOST_HOME/.env into process.env (existing process.env wins). */
export function loadEnv() {
  const envFile = path.join(home(), '.env')
  if (!fs.existsSync(envFile)) return
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m || line.trim().startsWith('#')) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v
  }
}

/** CDP debug port shared by browser-based channels (Brunch, Naver, LinkedIn stats). */
export function cdpPort() {
  return Number(process.env.CROSSPOST_CDP_PORT || 9224)
}
