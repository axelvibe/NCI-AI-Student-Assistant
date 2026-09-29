#!/usr/bin/env python3
"""Check every source URL in knowledge.json, plus any bare URLs inside answers.

Usage:
    python3 check_links.py                     # human-readable report
    python3 check_links.py --json              # machine-readable, for CI
    python3 check_links.py --timeout 20

Exit codes: 0 = everything OK, 1 = at least one problem found.

A 403 is reported separately from a 404. NCI's Support Hub sits behind a bot
filter that answers 403 to anything that does not look like a browser, so a 403
is a weak signal and not proof the page is gone. Only 404/410 and DNS failures
are treated as real breakage.
"""
import json, os, re, sys, ssl, socket, argparse, time
import concurrent.futures as futures
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from urllib.parse import urlparse

BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

# Hosts that are known to reject non-browser clients. Recorded so the report is
# honest about why a URL could not be confirmed rather than calling it broken.
SOFT_BLOCK = ("ncisupporthub.ncirl.ie", "ncirl.libanswers.com", "ncisu.ie",
              "info.ncirl.ie", "cloud.ncirl.ie", "studentprint.ncirl.ie")

URL_RE = re.compile(r'https?://[^\s<>"\')]+')


def check(url, timeout):
    """Check one URL, retrying once on transient failures so that a momentary
    network hiccup is not reported as a dead link."""
    for attempt in range(2):
        url, status, detail = _check_once(url, timeout)
        if status not in ("TIMEOUT", "UNREACHABLE", "ERROR"):
            return url, status, detail
        last = (url, status, detail)
        if attempt == 0:
            time.sleep(2)
    return last


def _check_once(url, timeout):
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return url, "INVALID", "unsupported scheme"
    req = Request(url, headers={
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-IE,en;q=0.9",
    })
    try:
        # no body needed; a redirect chain that ends in 200 is enough
        with urlopen(req, timeout=timeout) as r:
            return url, "OK", "%d%s" % (r.status, " -> " + r.url if r.url != url else "")
    except HTTPError as e:
        if e.code in (403, 401, 429):
            return url, "BLOCKED", "HTTP %d (bot filter, not proof of removal)" % e.code
        if e.code in (404, 410):
            return url, "BROKEN", "HTTP %d %s" % (e.code, e.reason)
        if 300 <= e.code < 400:
            return url, "REDIRECT", "HTTP %d" % e.code
        return url, "HTTP_%d" % e.code, e.reason or ""
    except URLError as e:
        reason = getattr(e, "reason", e)
        if isinstance(reason, ssl.SSLCertVerificationError):
            return url, "TLS", "certificate problem: %s" % reason.verify_message
        if isinstance(reason, socket.gaierror):
            return url, "BROKEN", "DNS: host not found"
        return url, "UNREACHABLE", str(reason)
    except socket.timeout:
        return url, "TIMEOUT", "no response in %ss" % timeout
    except Exception as e:                                    # noqa: BLE001
        return url, "ERROR", "%s: %s" % (type(e).__name__, e)


def collect(kb):
    """Every source link, plus any bare URL that appears inside an answer."""
    found = {}
    for e in kb["entries"]:
        if e.get("link"):
            found.setdefault(e["link"], []).append(e["id"])
        for extra in e.get("links", []) or []:
            found.setdefault(extra, []).append(e["id"])
        for u in URL_RE.findall(e.get("answer", "")):
            u = u.rstrip(".,;)")
            found.setdefault(u, []).append(e["id"])
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kb", nargs="?", default="knowledge.json")
    ap.add_argument("--timeout", type=float, default=15)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    kb = json.load(open(args.kb, encoding="utf-8"))
    targets = collect(kb)
    urls = sorted(targets)

    results = []
    with futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        for url, status, detail in ex.map(lambda u: check(u, args.timeout), urls):
            results.append({"url": url, "status": status, "detail": detail,
                            "used_by": sorted(set(targets[url]))})

    order = {"BROKEN": 0, "UNREACHABLE": 1, "DNS": 2, "INVALID": 3, "HTTP_5": 4,
             "TIMEOUT": 5, "TLS": 6, "HTTP_4": 7, "REDIRECT": 8, "BLOCKED": 9, "OK": 10}
    for r in results:
        if r["status"].startswith("HTTP_5"):
            r["status"] = "HTTP_5"
        elif r["status"].startswith("HTTP_4"):
            r["status"] = "HTTP_4"
    results.sort(key=lambda r: (order.get(r["status"], 99), r["url"]))

    problems = [r for r in results if r["status"] in ("BROKEN", "UNREACHABLE", "INVALID", "HTTP_5", "TLS")]
    blocked = [r for r in results if r["status"] == "BLOCKED"]

    if args.json:
        print(json.dumps({"total": len(results), "problems": len(problems),
                          "blocked": len(blocked), "results": results}, indent=2))
        return 1 if problems else 0

    print("Checked %d unique URLs from %d entries\n" % (len(results), len(kb["entries"])))
    buckets = {}
    for r in results:
        buckets.setdefault(r["status"], []).append(r)

    for status in sorted(buckets, key=lambda s: order.get(s, 99)):
        rows = buckets[status]
        print("%-10s %d" % (status, len(rows)))
        for r in rows:
            soft = " [host blocks bots]" if urlparse(r["url"]).netloc in SOFT_BLOCK else ""
            print("    %s" % r["url"])
            print("        %s | used by: %s%s" % (r["detail"], ", ".join(r["used_by"]), soft))
        print()

    print("=" * 70)
    if problems:
        print("FAILED: %d URL(s) need attention." % len(problems))
        return 1
    print("PASSED: no broken or unreachable URLs.")
    if blocked:
        print("Note: %d URL(s) returned a bot-block. Open those in a browser to confirm." % len(blocked))
    return 0


if __name__ == "__main__":
    sys.exit(main())
