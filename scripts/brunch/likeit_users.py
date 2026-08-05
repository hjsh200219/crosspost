#!/usr/bin/env python3
"""Print the accounts that liked a set of Brunch articles as JSON on stdout.

**Why Python — the only non-Node process in this plugin.**
`GET https://api.brunch.co.kr/v1/likeit/users/<articleNo>?createTime=<cursor>` answers
**401 "authentication failed"** to node fetch (undici) and to the system `curl` alike —
same cookie, same headers, over HTTP/1.1 and HTTP/2 both. With curl_cffi (BoringSSL) the
same request returns **200**. Brunch inspects the TLS stack on this private endpoint, and
no header combination gets around it.

**Do not turn impersonation on (counter-intuitive).** `impersonate='chrome'`, `chrome124`,
`chrome131` and `safari17_0` all return **401**; only plain curl_cffi with no impersonation
returns 200 (reproduced three times each, including with a fresh Session). A stealth-first
fetcher library therefore *breaks* this endpoint — that is why the transport is used
directly, with no options. The reason is unknown and not worth guessing at.

Response contract (measured):
    data.list[]         {userId, userName, profileId, description, myWriter, myFollower,
                         createTime, articleCount, writerCount, followerCount, ...}
    data.totalCount     authoritative count (matches "N people liked this")
    data.moreList       whether another page exists
    data.lastCreateTime cursor for the next request
  **`myWriter` = whether you already subscribe to that person** — the same field follow-back
  uses, so candidate selection reads it directly (false = not subscribed = candidate).

usage: python3 likeit_users.py --cookie-file <path> --articles 117 116 115
output: {"ok": true, "articles": [{"articleNo": "117", "totalCount": 19, "users": [...]}, ...],
         "errors": [{"articleNo": "...", "message": "..."}]}
A non-200 or a parse failure is recorded per article and the rest continue, so the caller can
tell a partial failure from an empty result.
"""

import argparse
import json
import sys

try:
    from curl_cffi import requests
except ImportError:  # never fold a missing dependency into an empty result
    print(json.dumps({
        "ok": False,
        "error": "curl_cffi is not installed — run: pip3 install curl_cffi "
                 "(needed only for Brunch follow-likers; every other channel is pure Node)",
    }), flush=True)
    sys.exit(2)

API = "https://api.brunch.co.kr/v1/likeit/users"
MAX_PAGES = 40  # backstop — 40 pages on one article means the structure changed


def fetch_article(session, cookie, article_no):
    """Every liker of one article. Returns (users, total_count); failures raise."""
    headers = {
        "Cookie": cookie,
        "Referer": "https://brunch.co.kr/",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "ko",
    }
    users, total, cursor = [], None, 0
    for _ in range(MAX_PAGES):
        # No impersonate argument — see the module docstring (turning it on returns 401).
        res = session.get(f"{API}/{article_no}?createTime={cursor}", headers=headers, timeout=25)
        if res.status_code != 200:
            raise RuntimeError(f"HTTP {res.status_code}: {res.text[:120]}")
        data = (res.json() or {}).get("data") or {}
        if total is None:
            total = data.get("totalCount")
        batch = data.get("list") or []
        users.extend(batch)
        if not data.get("moreList") or not batch:
            break
        cursor = data.get("lastCreateTime")
        if not cursor:
            break
    # A positive total with zero parsed users is a read failure. Folding it into an empty list
    # would report "no candidates" forever and look perfectly healthy.
    if (total or 0) > 0 and not users:
        raise RuntimeError(f"totalCount={total} but the list came back empty — treating as a read failure")
    return users, total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cookie-file", required=True)
    ap.add_argument("--articles", nargs="+", required=True)
    args = ap.parse_args()

    with open(args.cookie_file, encoding="utf-8") as fh:
        cookie = fh.read().strip()

    out, errors = [], []
    with requests.Session() as session:
        for no in args.articles:
            try:
                users, total = fetch_article(session, cookie, no)
                out.append({"articleNo": str(no), "totalCount": total, "users": users})
            except Exception as exc:  # one article's failure skips only that article
                errors.append({"articleNo": str(no), "message": str(exc)[:200]})

    print(json.dumps({"ok": True, "articles": out, "errors": errors}, ensure_ascii=False))


if __name__ == "__main__":
    main()
