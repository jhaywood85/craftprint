#!/usr/bin/env bash
# Assemble the deployable app into dist/ — just the files the browser needs,
# leaving out the server, tests, tools, and docs. The Worker serves dist/ as
# static assets (see server/wrangler.toml).
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf dist
mkdir -p dist
cp index.html style.css manifest.webmanifest sw.js dist/
cp -r src vendor icons landing dist/

echo "dist/ ready:"
du -sh dist
