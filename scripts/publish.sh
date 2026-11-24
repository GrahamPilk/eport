#!/usr/bin/env bash
# Publish a Markdown file (with frontmatter) to the live site.
#   SITE=https://example.com PUBLISH_TOKEN=... scripts/publish.sh post.md
set -euo pipefail
f="${1:?usage: publish.sh post.md}"
slug="${SLUG:-$(basename "$f" .md)}"
curl -fsS -X POST "${SITE:?}/api/posts?slug=${slug}&wait=1" \
  -H "Authorization: Bearer ${PUBLISH_TOKEN:?}" \
  -H 'Content-Type: text/markdown' \
  --data-binary @"$f"
echo
