#!/bin/bash
# Daily Morning Brief stats snapshot -> CSV log.
set -euo pipefail
ADMIN_KEY=$(cat ~/workspace/morning-briefing/pipeline/.admin-key)
CSV=~/workspace/your_files/morning-brief-stats.csv
STATS=$(curl -s --max-time 30 "https://morningbrief.link/api/admin/stats?key=${ADMIN_KEY}")
DATE=$(date +%F)
TOTAL=$(echo "$STATS" | python3 -c "import json,sys; print(json.load(sys.stdin)['total_users'])")
TICKERS=$(echo "$STATS" | python3 -c "import json,sys; print(json.load(sys.stdin)['total_tickers'])")
AVG=$(echo "$STATS" | python3 -c "import json,sys; print(json.load(sys.stdin)['avg_tickers_per_user'])")
NO_TICK=$(echo "$STATS" | python3 -c "import json,sys; print(json.load(sys.stdin)['users_with_no_tickers'])")
if [ ! -f "$CSV" ]; then
  echo "date,total_users,total_tickers,avg_tickers_per_user,users_with_no_tickers" > "$CSV"
fi
echo "${DATE},${TOTAL},${TICKERS},${AVG},${NO_TICK}" >> "$CSV"
