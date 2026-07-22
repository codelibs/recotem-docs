#!/usr/bin/env bash
#
# indexnow-submit.sh — notify IndexNow (Bing, Yandex, etc.) of all site URLs.
#
# Reads every <loc> URL from the live sitemap and submits them to the IndexNow
# API in one batch. Run this after a deploy so search engines re-crawl promptly.
#
# The key below MUST match the filename/content of public/<KEY>.txt, which
# VitePress publishes at https://recotem.org/<KEY>.txt. The key is NOT a secret;
# it is intentionally served publicly to prove ownership of the host.
set -euo pipefail

KEY="3383bb633485a9299e92d328947d3762"

HOST="recotem.org"
SITEMAP="https://${HOST}/sitemap.xml"
KEY_LOCATION="https://${HOST}/${KEY}.txt"
ENDPOINT="https://api.indexnow.org/indexnow"

# Extract all <loc> URLs from the sitemap (portable; no mapfile/bash4 needed).
URLS=()
while IFS= read -r line; do
  [ -n "$line" ] && URLS+=("$line")
done < <(curl -fsSL "$SITEMAP" \
  | grep -oE '<loc>[^<]+</loc>' \
  | sed -E 's#</?loc>##g')

if [ "${#URLS[@]}" -eq 0 ]; then
  echo "No URLs found in $SITEMAP — aborting." >&2
  exit 1
fi

echo "Submitting ${#URLS[@]} URLs from $SITEMAP to IndexNow..."

# Build the JSON payload with jq (urlList as a JSON array).
PAYLOAD=$(printf '%s\n' "${URLS[@]}" | jq -R . | jq -s \
  --arg host "$HOST" \
  --arg key "$KEY" \
  --arg keyLocation "$KEY_LOCATION" \
  '{host: $host, key: $key, keyLocation: $keyLocation, urlList: .}')

STATUS=$(curl -sS -o /dev/null -w '%{http_code}' \
  -X POST "$ENDPOINT" \
  -H 'Content-Type: application/json; charset=utf-8' \
  --data "$PAYLOAD")

echo "IndexNow HTTP status: $STATUS"
case "$STATUS" in
  200|202) echo "Accepted (200/202)." ;;
  *) echo "Unexpected status — see https://www.indexnow.org/documentation for codes." >&2; exit 1 ;;
esac
