#!/usr/bin/env bash
# Pull latest code, rebuild, and hot-reload via PM2.
# Run from repo root: bash deploy/update.sh
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$INSTALL_DIR"

echo "=== Pulling latest ==="
git pull origin "$(git rev-parse --abbrev-ref HEAD)"

echo "=== Rebuilding Apex Unified ==="
cd apex-unified && npm run build && cd ..

echo "=== Reloading PM2 ==="
pm2 reload apex-unified --update-env

echo "Update complete"
pm2 ls
