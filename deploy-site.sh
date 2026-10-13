#!/bin/bash
# Safe site deploy with verification. Use this instead of pages-deploy-full.py.
set -e

cd ~/workspace/morning-briefing

echo "Deploying with v2 script..."
OUTPUT=$(python3 ~/workspace/skills/cloudflare/bin/pages-deploy-v2.py 2>&1)
echo "$OUTPUT"

# Extract deployment URL
URL=$(echo "$OUTPUT" | grep -o 'https://[^ ]*\.pages\.dev' | head -1)
if [ -z "$URL" ]; then
  echo "ERROR: No deployment URL found"
  exit 1
fi

echo "Verifying $URL..."
sleep 5
CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$URL/")
if [ "$CODE" != "200" ]; then
  echo "ERROR: Deployment returned $CODE, not 200. Site may be broken."
  exit 1
fi

# Verify main domain too
MAIN_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "https://morningbrief.link/")
echo "Main site: $MAIN_CODE"

if [ "$CODE" = "200" ]; then
  echo "Deploy verified OK"
else
  echo "WARNING: Deployment URL works but main domain returns $MAIN_CODE"
fi
