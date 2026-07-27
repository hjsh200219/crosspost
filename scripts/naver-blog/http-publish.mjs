// Browserless Naver blog publishing — the SmartEditor ONE editor's own network calls, made
// directly.
//
// Naver shut its blog write API down in 2020, which is why this channel drove the editor UI.
// But the editor is a thin client over four ordinary endpoints, and all four answer a plain
// cookie'd request (verified end-to-end 2026-07-27):
//
//   1. GET  blog.naver.com/PostWriteFormSeOptions.naver?blogId=      → se-authorization JWT
//   2. GET  platform.editor.naver.com/api/blogpc001/v1/photo-uploader/session-key  (JWT header)
//   3. POST blog.upphoto.naver.com/<sessionKey>/simpleUpload/0       → image path/size/dims
//   4. POST blog.naver.com/RabbitWrite.naver                         → logNo
//
// Step 4 takes `documentModel` (the SE-ONE document JSON) and `populationParams` as ordinary
// form fields. There is no CSRF token and no editor handshake to replay.
//
// The generated document mirrors what the UI automation actually produced, checked against
// live posts: the component histogram is only ever documentTitle / image / text /
// horizontalLine / sectionTitle. Note that the UI's "hyperlinked canonical trailer" never
// actually rendered as a link (no link nodes exist in any published document) — the trailer
// is plain text there too, and reproducing that keeps a change of transport from also being
// a silent change of output.
import { readFileSync } from 'fs';
import path from 'path';
import { randomUUID, randomBytes } from 'crypto';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
// Editor build id the photo-uploader expects alongside the JWT. Opaque but stable.
const SE_APP_ID = 'SE-fc834445-a14c-46cf-95c8-84015864dc4f';
// Opaque marker the editor stamps on every publish; copied verbatim from a real request.
const EDITOR_SOURCE = 'UzIPRMwLqATgcCYRYRm03Q==';
// SE-ONE lays images out at 886px wide; anything larger is downscaled by the editor, so we
// record the same numbers it would have.
const EDITOR_IMAGE_WIDTH = 886;

const seId = () => `SE-${randomUUID()}`;
// ULID-shaped document id (Crockford base32, 26 chars) — the editor generates one per document.
function ulid() {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  return [...randomBytes(26)].map((b) => A[b % 32]).join('');
}

const paragraph = (value) => ({ '@ctype': 'paragraph', id: seId(), nodes: [{ '@ctype': 'textNode', id: seId(), value }] });
const textComponent = (lines) => ({ '@ctype': 'text', id: seId(), layout: 'default', value: lines.map(paragraph) });
const sectionTitle = (value) => ({ '@ctype': 'sectionTitle', id: seId(), layout: 'default', title: [paragraph(value)] });
const horizontalLine = () => ({ '@ctype': 'horizontalLine', id: seId(), layout: 'default' });

function imageComponent(up, represent) {
  const ow = up.width || EDITOR_IMAGE_WIDTH;
  const oh = up.height || 0;
  const width = Math.min(ow, EDITOR_IMAGE_WIDTH);
  // floor, not round — matches what the editor records (886x553 for a 1400x875 source)
  const height = oh && ow ? Math.floor((oh * width) / ow) : oh;
  return {
    '@ctype': 'image',
    id: seId(),
    layout: 'default',
    src: `${up.domain}${up.path}?type=w1`,
    internalResource: true,
    represent,
    path: up.path,
    domain: up.domain,
    fileSize: up.fileSize,
    width,
    widthPercentage: 0.0,
    height,
    originalWidth: ow,
    originalHeight: oh,
    fileName: up.fileName,
    format: 'normal',
    displayFormat: 'normal',
    origin: { '@ctype': 'imageOrigin', srcFrom: 'local' },
    contentMode: 'fit',
    ai: false,
  };
}

const get = (url, cookie, extra = {}) => fetch(url, { headers: { cookie, 'user-agent': UA, ...extra } });

export async function seToken(cookie, blogId) {
  const r = await get(`https://blog.naver.com/PostWriteFormSeOptions.naver?blogId=${blogId}`, cookie, {
    referer: `https://blog.naver.com/${blogId}`,
  });
  const j = await r.json();
  const token = j?.result?.token;
  if (!token) throw new Error('no se-authorization token — the Naver session may have expired');
  return token;
}

// name → categoryNo, from the same list the publish popup shows.
// Only the mobile host serves this; the desktop path 404s.
export async function categoryMap(cookie, blogId) {
  const r = await get(`https://m.blog.naver.com/api/blogs/${blogId}/category-list`, cookie, {
    referer: `https://m.blog.naver.com/${blogId}`,
  });
  const j = await r.json();
  const list = j?.result?.mylogCategoryList || [];
  return new Map(list.map((c) => [String(c.categoryName).trim(), c.categoryNo]));
}

// The upload answers XML, not JSON.
const xmlField = (xml, tag) => (xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1];

export async function uploadImage(cookie, jwt, blogId, absPath) {
  const sk = await get('https://platform.editor.naver.com/api/blogpc001/v1/photo-uploader/session-key', cookie, {
    referer: `https://blog.naver.com/PostWriteForm.naver?blogId=${blogId}&Redirect=Write`,
    accept: 'application/json',
    'se-authorization': jwt,
    'se-app-id': SE_APP_ID,
  });
  const sessionKey = (await sk.json())?.sessionKey;
  if (!sessionKey) throw new Error('photo-uploader session-key request failed');

  const buf = readFileSync(absPath);
  const name = path.basename(absPath);
  // Send the real type rather than converting locally — Naver transcodes webp to JPEG on
  // its side (published documents carry `<fileName>*.jpg` for .webp sources).
  const ext = path.extname(name).toLowerCase().slice(1);
  const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const fd = new FormData();
  fd.append('image', new Blob([buf], { type: mime }), name);
  const up = await fetch(
    `https://blog.upphoto.naver.com/${sessionKey}/simpleUpload/0?userId=${blogId}` +
      `&extractExif=true&extractAnimatedCnt=true&autorotate=true&extractDominantColor=false&_ts=${Date.now()}`,
    { method: 'POST', headers: { cookie, 'user-agent': UA, referer: 'https://blog.naver.com/' }, body: fd },
  );
  const xml = await up.text();
  const p = xmlField(xml, 'path');
  if (!p) throw new Error(`image upload failed (${name}): ${xml.slice(0, 120)}`);
  return {
    path: p,
    domain: 'https://blogfiles.pstatic.net',
    fileName: xmlField(xml, 'fileName') || name,
    fileSize: Number(xmlField(xml, 'fileSize') || buf.length),
    width: Number(xmlField(xml, 'width') || 0),
    height: Number(xmlField(xml, 'height') || 0),
  };
}

// Build the SE-ONE document from a plain-text post: first line = title, body paragraphs are
// blank-line separated, and a paragraph starting with "## " becomes a section heading — the
// same content model the UI path used.
export function buildDocumentModel({ title, body, cover, trailer }) {
  const components = [{ '@ctype': 'documentTitle', id: seId(), layout: 'default', align: 'left', title: [paragraph(title)] }];
  if (cover) components.push(imageComponent(cover, true));

  for (const para of String(body || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    if (para.startsWith('## ')) components.push(sectionTitle(para.slice(3).trim()));
    else components.push(textComponent(para.split('\n')));
  }

  if (trailer) {
    components.push(horizontalLine());
    components.push(textComponent([trailer]));
  }

  return {
    documentId: '',
    document: {
      version: '2.10.2',
      theme: 'default',
      language: 'ko-KR',
      id: ulid(),
      components,
      di: { dif: false, dio: [{ dis: 'N', dia: { t: 0, p: 0, st: 11, sk: 1 } }] },
    },
  };
}

// openType 2 = public, 0 = private (used by the verification path).
export async function publishDocument({ cookie, blogId, documentModel, categoryNo, tags = [], openType = 2 }) {
  const populationParams = {
    configuration: {
      openType,
      commentYn: true,
      searchYn: openType === 2,
      sympathyYn: true,
      scrapType: 1,
      outSideAllowYn: false,
      twitterPostingYn: false,
      facebookPostingYn: false,
      cclYn: false,
    },
    populationMeta: {
      categoryId: categoryNo,
      logNo: null,
      directorySeq: 30,
      directoryDetail: null,
      mrBlogTalkCode: null,
      postWriteTimeType: 'now',
      tags: tags.length ? tags.join(',') : null,
      moviePanelParticipation: false,
      greenReviewBannerYn: false,
      continueSaved: false,
      noticePostYn: false,
      autoByCategoryYn: false,
      postLocationSupportYn: false,
      postLocationJson: null,
      thisDayPostInfo: null,
      scrapYn: false,
    },
    editorSource: EDITOR_SOURCE,
  };
  const body = new URLSearchParams({
    blogId,
    documentModel: JSON.stringify(documentModel),
    mediaResources: JSON.stringify({ image: [], video: [], file: [] }),
    populationParams: JSON.stringify(populationParams),
    productApiVersion: 'v1',
  });
  const r = await fetch('https://blog.naver.com/RabbitWrite.naver', {
    method: 'POST',
    headers: {
      cookie,
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded',
      referer: `https://blog.naver.com/PostWriteForm.naver?blogId=${blogId}&Redirect=Write`,
      origin: 'https://blog.naver.com',
    },
    body: body.toString(),
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`could not parse RabbitWrite response: ${text.slice(0, 160)}`); }
  if (!j.isSuccess) throw new Error(`publish failed: ${JSON.stringify(j.result || j).slice(0, 200)}`);
  const logNo = (j.result?.redirectUrl || '').match(/logNo=(\d+)/)?.[1];
  if (!logNo) throw new Error(`could not parse logNo: ${JSON.stringify(j.result).slice(0, 160)}`);
  return logNo;
}

// Read a published post's document back — used to verify a publish rather than trusting
// isSuccess. Returns the component list.
export async function readDocument(cookie, blogId, logNo) {
  const r = await get(`https://blog.naver.com/PostWriteFormSeOptions.naver?blogId=${blogId}&logNo=${logNo}`, cookie, {
    referer: `https://blog.naver.com/${blogId}`,
  });
  const dm = (await r.json())?.result?.documentModel;
  if (!dm) return null;
  const parsed = typeof dm === 'string' ? JSON.parse(dm) : dm;
  return parsed.document?.components || parsed.components || null;
}
