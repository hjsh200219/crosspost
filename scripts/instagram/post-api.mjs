#!/usr/bin/env node
/**
 * Instagram publisher — Instagram Graph API (Content Publishing).
 *
 *   node post-api.mjs <slug>                  # reel (single video) — the default format
 *   node post-api.mjs <slug> --carousel       # image / carousel
 *   node post-api.mjs <slug> --dry-run        # build containers, don't publish
 *   node post-api.mjs <slug> --skip-done      # skip if (slug, format) is already in the ledger
 *   node post-api.mjs <slug> --media a.jpg,b.jpg   # explicit media (URLs or paths under the media base)
 *   node post-api.mjs --delete <media-id>
 *   node post-api.mjs --edit <media-id> <slug>     # caption only — and it usually does nothing (see below)
 *
 * WHY THIS CHANNEL IS DIFFERENT: Instagram cannot publish text, and its API does not accept
 * binary uploads — Meta fetches `image_url`/`video_url` from a PUBLIC URL. So publishing here
 * has a hosting prerequisite the other channels don't:
 *
 *   1. render or supply the media,
 *   2. put it somewhere publicly reachable,
 *   3. set CROSSPOST_MEDIA_BASE_URL to that location.
 *
 * Media resolution, in order:
 *   --media a.jpg,b.jpg                     explicit; absolute URLs used as-is
 *   $CROSSPOST_HOME/posts/<slug>.insta.media  one URL or path per line (comments with #)
 *   $CROSSPOST_HOME/media/<slug>/reel.mp4     the default (reels)
 *   $CROSSPOST_HOME/media/<slug>/card-NN.jpg  what gen-cards.mjs --carousel writes
 *
 * Caption: `$CROSSPOST_HOME/posts/<slug>.insta.txt`, falling back to the canonical post body.
 *
 * env: IG_USER_ID, IG_ACCESS_TOKEN, CROSSPOST_MEDIA_BASE_URL
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, dataPath, home } from '../lib/env.mjs';
import { canonicalLink } from '../lib/canonical-link.mjs';
import { playable } from '../lib/mp4.mjs';
import { validateCaption } from './card-rules.mjs';

loadEnv();

const GRAPH = 'https://graph.facebook.com/v21.0';
const LEDGER = dataPath('ledgers/published-instagram.json');
const POSTS = dataPath('posts');
const IG = process.env.IG_USER_ID;
const TOKEN = process.env.IG_ACCESS_TOKEN;
if (!IG || !TOKEN) { console.error('missing IG_USER_ID / IG_ACCESS_TOKEN in $CROSSPOST_HOME/.env'); process.exit(1); }
const MEDIA_BASE = (process.env.CROSSPOST_MEDIA_BASE_URL || '').replace(/\/+$/, '');

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : null; };

const post = async (path, params) => {
  const r = await fetch(`${GRAPH}${path}`, { method: 'POST', body: new URLSearchParams({ ...params, access_token: TOKEN }) });
  const d = await r.json();
  if (d.error) throw new Error(JSON.stringify(d.error));
  return d;
};
const get = async (path, fields) => {
  const r = await fetch(`${GRAPH}${path}?fields=${fields}&access_token=${encodeURIComponent(TOKEN)}`);
  const d = await r.json();
  if (d.error) throw new Error(JSON.stringify(d.error));
  return d;
};

const captionFor = (slug) => {
  for (const name of [`${slug}.insta.txt`, `${slug}.txt`]) {
    const p = join(POSTS, name);
    if (existsSync(p)) {
      const raw = readFileSync(p, 'utf8').trim();
      // Canonical files are publishable bodies, not metadata documents. Their first line is
      // the cross-channel opening hook and must remain in the Instagram fallback caption.
      return raw;
    }
  }
  return null;
};

// --- edit (caption only, and Instagram usually ignores it) ---
// Media cannot be replaced after publishing. Captions look editable — `POST /{ig-media-id}`
// accepts the field and answers `{"success":true}` — but the change frequently does not take,
// so this reads the caption back and fails when it did not change. A silent local-only "edit"
// is worse than no edit: it desynchronizes your files from what is live.
const editIdx = args.indexOf('--edit');
if (editIdx !== -1) {
  const mediaId = args[editIdx + 1];
  const editSlug = args[editIdx + 2];
  if (!mediaId || !editSlug) { console.error('usage: node post-api.mjs --edit <media-id> <slug>'); process.exit(1); }
  const body = captionFor(editSlug);
  if (!body) { console.error(`no caption file for ${editSlug}`); process.exit(1); }
  await post(`/${mediaId}`, { caption: body, comment_enabled: 'true' });
  const back = await get(`/${mediaId}`, 'caption');
  if ((back.caption || '').trim() !== body.trim()) {
    console.error('caption did not change on Instagram (the API accepted it and ignored it).');
    console.error('To actually change it you must delete and re-publish — which resets the URL and its metrics.');
    process.exit(1);
  }
  console.log(`edited caption: ${mediaId} (${body.length} chars, verified by read-back)`);
  process.exit(0);
}

const delId = flag('--delete');
if (delId) {
  const r = await fetch(`${GRAPH}/${delId}?access_token=${encodeURIComponent(TOKEN)}`, { method: 'DELETE' });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  const confirmed = data === true || data?.success === true;
  if (!r.ok || data?.error || !confirmed) {
    console.error(`delete ${r.status}: ${data?.error ? JSON.stringify(data.error) : text.slice(0, 300)}`);
    process.exit(1);
  }
  if (existsSync(LEDGER)) {
    const ledger = JSON.parse(readFileSync(LEDGER, 'utf8')).filter((entry) => entry.id !== delId);
    writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n');
  }
  console.log(`deleted: ${delId}`);
  process.exit(0);
}

const slug = args.find((a) => !a.startsWith('--') && a !== flag('--media'));
const dryRun = args.includes('--dry-run');
const skipDone = args.includes('--skip-done');
if (!slug) { console.error('usage: node post-api.mjs <slug> [--carousel] [--dry-run] [--skip-done] [--media a.jpg,b.jpg]'); process.exit(1); }
// Reels are the default; a carousel is opt-in. `--reels` stays accepted so existing callers and
// scripts keep working, it just no longer changes anything.
const format = args.includes('--carousel') ? 'carousel' : 'reels';
const REELS = format === 'reels';

// Idempotence guard for retries. It keys on (slug, format) rather than slug alone, because
// publishing the same post as both a carousel and a reel is a legitimate thing to do.
const readLedger = () => (existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : []);
if (skipDone) {
  const done = readLedger().find((e) => e.slug === slug && (e.format || 'carousel') === format);
  if (done) { console.log(`already published, skipping: ${slug} (${format}) ${done.permalink || done.id}`); process.exit(0); }
}

// --- media ---
const toUrl = (ref) => {
  if (/^https?:\/\//.test(ref)) return ref;
  if (!MEDIA_BASE) {
    console.error(`"${ref}" is a relative path but CROSSPOST_MEDIA_BASE_URL is not set.\n` +
      'Instagram fetches media from a public URL, so relative paths need a base to resolve against.');
    process.exit(1);
  }
  return `${MEDIA_BASE}/${String(ref).replace(/^\/+/, '')}`;
};

let media = [];
const explicit = flag('--media');
const listFile = join(POSTS, `${slug}.insta.media`);
if (explicit) {
  media = explicit.split(',').map((s) => s.trim()).filter(Boolean);
} else if (existsSync(listFile)) {
  media = readFileSync(listFile, 'utf8').split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
} else {
  const dir = dataPath(`media/${slug}`);
  if (REELS) {
    // Playable, not merely present — a truncated render would be handed to Meta as a URL and
    // fail at the container stage with nothing to point at (see lib/mp4.mjs).
    if (playable(join(dir, 'reel.mp4'))) media = [`${slug}/reel.mp4`];
  } else if (existsSync(dir)) {
    media = readdirSync(dir).filter((f) => /^card-\d+\.(jpg|jpeg|png)$/i.test(f)).sort().map((f) => `${slug}/${f}`);
  }
}
if (!media.length) {
  console.error(
    `no media for "${slug}". Instagram has no text-only post, so this fails instead of falling back.\n` +
    (REELS
      ? `  · render a reel: node gen-cards.mjs ${slug} && node gen-reel.mjs ${slug}\n` +
        `  · or, if this is a carousel: --carousel\n`
      : `  · render cards:  node gen-cards.mjs ${slug} --carousel\n`) +
    `  · or list URLs:  ${listFile.replace(home(), '$CROSSPOST_HOME')}\n` +
    '  · or pass:       --media https://…/a.jpg,https://…/b.jpg',
  );
  process.exit(1);
}
// Format/media mismatch, caught here rather than at Meta. Now that reels are the default, a
// caller who supplies images without --carousel would otherwise get a container error naming the
// URL, which reads as a broken image rather than a wrong flag.
const isVideo = (ref) => /\.(mp4|mov|m4v)(\?|$)/i.test(String(ref));
if (REELS && !media.every(isVideo)) {
  console.error(
    `"${slug}" resolved to image media, but the format is reels (the default).\n` +
    '  · publish it as a carousel: add --carousel\n' +
    `  · or render a reel:         node gen-cards.mjs ${slug} && node gen-reel.mjs ${slug}`,
  );
  process.exit(1);
}
if (REELS && media.length > 1) { console.error(`a reel is a single video (${media.length} media given) — use --carousel for multiple items`); process.exit(1); }
if (!REELS && media.length > 10) { console.error(`a carousel holds at most 10 items (${media.length} given)`); process.exit(1); }
const urls = media.map(toUrl);

// --- caption ---
const caption = captionFor(slug);
if (caption == null) { console.error(`no caption: ${join(POSTS, `${slug}.insta.txt`).replace(home(), '$CROSSPOST_HOME')}`); process.exit(1); }
const canonical = canonicalLink(join(POSTS, `${slug}.txt`));
const capCheck = validateCaption(caption, { canonicalUrl: canonical });
for (const w of capCheck.warnings) console.error(`  warn: ${w}`);
if (capCheck.errors.length) { for (const e of capCheck.errors) console.error(`  - ${e}`); process.exit(1); }

console.log(`${slug}: ${REELS ? 'reel' : `${urls.length} image(s)`} · caption ${caption.length} chars`);

// Meta transcodes video server-side, so a reel container takes far longer to become ready than
// an image one. Using the image timeout for video kills containers that were processing fine.
const waitReady = async (id, maxMs = 90000, everyMs = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const d = await get(`/${id}`, 'status_code');
    if (d.status_code === 'FINISHED') return;
    if (d.status_code === 'ERROR') throw new Error(`container ERROR: ${id} — check that the media URL is publicly reachable`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`container timed out: ${id}`);
};

let parent;
if (REELS) {
  const params = {
    media_type: 'REELS',
    video_url: urls[0],
    caption,
    share_to_feed: 'true', // without this the reel can be missing from the profile grid
  };
  parent = await post(`/${IG}/media`, params);
  console.log(`reel container: ${parent.id} — waiting for transcode (up to 5 min)`);
  await waitReady(parent.id, 300000, 5000);
} else if (urls.length === 1) {
  parent = await post(`/${IG}/media`, { image_url: urls[0], caption });
  await waitReady(parent.id);
  console.log(`image container: ${parent.id}`);
} else {
  const children = [];
  for (const url of urls) {
    const c = await post(`/${IG}/media`, { image_url: url, is_carousel_item: 'true' });
    await waitReady(c.id);
    children.push(c.id);
    console.log(`  · ${url.split('/').pop()} → ${c.id}`);
  }
  parent = await post(`/${IG}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption });
  await waitReady(parent.id);
  console.log(`carousel container: ${parent.id}`);
}

// --dry-run stops here ON PURPOSE, after the containers exist: that is what proves Meta could
// actually fetch every URL, which is the failure mode worth catching before publishing.
if (dryRun) { console.log('--dry-run — containers built, nothing published'); process.exit(0); }

const pub = await post(`/${IG}/media_publish`, { creation_id: parent.id });

// media_publish가 성공한 순간 게시물은 라이브고 IG에선 되돌릴 수 없다. 장부 기록 전에
// 다른 호출(permalink 조회)이 끼어들어 실패하면 라이브 게시물이 장부에 없어
// --skip-done 재시도가 중복 발행한다 — 장부부터 쓰고 permalink는 best-effort로 채운다.
const entry = {
  slug,
  format, // a slug can go out as both a carousel and a reel — stats need to tell the rows apart
  id: pub.id,
  permalink: null,
  items: REELS ? 1 : urls.length,
  // 다른 채널과 동일: 날짜는 Asia/Seoul로 고정하고, publish-order.mjs가 실제로 정렬에
  // 쓰는 publishedAt을 남긴다. 없으면 IG 행만 기계 로컬 시간대의 거친 날짜로 정렬된다.
  date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()),
  publishedAt: new Date().toISOString(),
};
let ledger;
try {
  ledger = readLedger();
} catch (error) {
  console.error(`cannot read Instagram ledger: ${error.message}`);
  console.error('publish SUCCEEDED but was NOT recorded — repair the ledger, then append this entry manually:');
  console.error(JSON.stringify(entry, null, 2));
  process.exit(1);
}
ledger.push(entry);
writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n');

try {
  const info = await get(`/${pub.id}`, 'id,permalink,media_type,timestamp');
  if (info.permalink) {
    entry.permalink = info.permalink;
    writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n');
  }
} catch (error) {
  console.error(`  warn: permalink lookup failed — post IS live and recorded in the ledger (id ${pub.id}): ${error.message}`);
}
console.log(`published: ${entry.permalink || pub.id}`);
console.log(`ledger → ${LEDGER.replace(home(), '$CROSSPOST_HOME')}`);
