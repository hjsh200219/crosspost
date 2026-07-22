#!/usr/bin/env node
// Add a comment to one of your own LinkedIn posts (w_member_social).
// Used to attach a canonical link (e.g. your blog's full-length version) as the
// first comment — links in the post body hurt reach; first-comment links don't.
//
//   node comment-api.mjs <shareUrn> "<comment text>"
//   e.g. node comment-api.mjs urn:li:share:1234567890123456789 "Full version: https://example.com/blog/my-post"
import { parseAccount, loadEnv } from './account.mjs';

const { account, rest: ARGV } = parseAccount(process.argv.slice(2));
const authHint = `node auth.mjs${account === 'default' ? '' : ` --account ${account}`}`;
const { pick } = loadEnv(account);
const TOKEN = pick('LINKEDIN_ACCESS_TOKEN');
const ACTOR = pick('LINKEDIN_PERSON_URN');
const EXP = parseInt(pick('LINKEDIN_TOKEN_EXPIRES') || '0', 10);

if (!TOKEN || !ACTOR) { console.error(`no token/actor for account "${account}" — run: ${authHint}`); process.exit(1); }
if (EXP && Date.now() / 1000 > EXP) { console.error(`access token expired (account ${account}) — run: ${authHint}`); process.exit(1); }

const [urn, text] = ARGV;
if (!urn || !text) {
  console.error('usage: comment-api.mjs <shareUrn> "<comment text>"');
  process.exit(1);
}

const res = await fetch(
  `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(urn)}/comments`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'X-Restli-Protocol-Version': '2.0.0',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ actor: ACTOR, message: { text } }),
  },
);

if (!res.ok) {
  console.error(`comment ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const data = await res.json();
console.log('commented:', data.commentUrn || data.id || 'ok');
