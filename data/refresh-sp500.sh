#!/usr/bin/env bash
# Refresh data/sp500.json from the current S&P 500 constituent list.
#
# Source: Wikipedia "List of S&P 500 companies" (id="constituents" table).
# Wikipedia mirrors the official constituent list; refresh monthly or after
# known index changes. The file format matches ARCHITECTURE.md:
#   {"as_of": "YYYY-MM-DD", "count": N, "stocks": [{"ticker","name"}, ...]}
#
# Run: bash data/refresh-sp500.sh
set -euo pipefail
OUT="$(dirname "$0")/sp500.json"
AS_OF="$(date +%F)"
python3 - "$OUT" "$AS_OF" <<'EOF'
import re, sys, json, html, urllib.request
out_path, as_of = sys.argv[1], sys.argv[2]
url = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
page = urllib.request.urlopen(req, timeout=60).read().decode("utf-8")
body = re.search(r'<table[^>]*id="constituents"[^>]*>(.*?)</table>', page, re.S).group(1)
entries = []
for r in re.findall(r'<tr[^>]*>(.*?)</tr>', body, re.S)[1:]:
    cells = re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', r, re.S)
    if len(cells) < 2:
        continue
    sym = re.sub(r"\s+", "", re.sub(r"<[^>]+>", "", cells[0]).strip())
    name = html.unescape(re.sub(r"<[^>]+>", "", cells[1]).strip())
    if re.fullmatch(r"[A-Z][A-Z0-9.\-]*", sym):
        entries.append({"ticker": sym, "name": name})
assert len(entries) >= 495, f"unexpectedly few constituents: {len(entries)}"
tickers = [e["ticker"] for e in entries]
assert len(set(tickers)) == len(tickers), "duplicate tickers parsed"
json.dump({"as_of": as_of, "count": len(entries), "stocks": entries},
          open(out_path, "w"), indent=1)
print(f"wrote {out_path}: {len(entries)} constituents, as_of={as_of}")
EOF
