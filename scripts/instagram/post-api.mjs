#!/usr/bin/env node
/**
 * Instagram publisher — Instagram Graph API (Content Publishing).
 *
 *   node post-api.mjs <slug>                  # image / carousel
 *   node post-api.mjs <slug> --reels          # reel (single video)
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
 *   $CROSSPOST_HOME/media/<slug>/card-NN.jpg  what gen-cards.mjs writes (needs the base URL)
 *   $CROSSPOST_HOME/media/<slug>/reel.mp4     for --reels
 *
 * Caption: `$CROSSPOST_HOME/posts/<slug>.insta.txt`, falling back to the canonical post body.
 *
 * env: IG_USER_ID, IG_ACCESS_TOKEN, CROSSPOST_MEDIA_BASE_URL
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, dataPath, home } from '../lib/env.mjs';
import { canonicalLink } from '../lib/canonical-link.mjs';
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
      // the canonical file's first line is its title; the Instagram variant is caption-only
      return name.endsWith('.insta.txt') ? raw : raw.split('\n').slice(1).join('\n').trim();
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
  console.log(JSON.stringify(await r.json()));
  process.exit(0);
}

const slug = args.find((a) => !a.startsWith('--') && a !== flag('--media'));
const dryRun = args.includes('--dry-run');
const REELS = args.includes('--reels');
const skipDone = args.includes('--skip-done');
if (!slug) { console.error('usage: node post-api.mjs <slug> [--reels] [--dry-run] [--skip-done] [--media a.jpg,b.jpg]'); process.exit(1); }
const format = REELS ? 'reels' : 'carousel';

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
    if (existsSync(join(dir, 'reel.mp4'))) media = [`${slug}/reel.mp4`];
  } else if (existsSync(dir)) {
    media = readdirSync(dir).filter((f) => /^card-\d+\.(jpg|jpeg|png)$/i.test(f)).sort().map((f) => `${slug}/${f}`);
  }
}
if (!media.length) {
  console.error(
    `no media for "${slug}". Instagram has no text-only post, so this fails instead of falling back.\n` +
    `  · render cards:  node gen-cards.mjs ${slug}${REELS ? ' --reels && node gen-reel.mjs ' + slug : ''}\n` +
    `  · or list URLs:  ${listFile.replace(home(), '$CROSSPOST_HOME')}\n` +
    '  · or pass:       --media https://…/a.jpg,https://…/b.jpg',
  );
  process.exit(1);
}
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
const info = await get(`/${pub.id}`, 'id,permalink,media_type,timestamp');
console.log(`published: ${info.permalink || pub.id}`);

const ledger = readLedger();
ledger.push({
  slug,
  format, // a slug can go out as both a carousel and a reel — stats need to tell the rows apart
  id: pub.id,
  permalink: info.permalink || null,
  items: REELS ? 1 : urls.length,
  date: new Intl.DateTimeFormat('en-CA').format(new Date()),
});
writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n');
console.log(`ledger → ${LEDGER.replace(home(), '$CROSSPOST_HOME')}`);
