#!/usr/bin/env bash
# Pull latest code, rebuild, and hot-reload via PM2 (zero downtime).
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$INSTALL_DIR"
export PATH=$PATH:/usr/local/go/bin

echo "=== Pulling latest ==="
git pull origin "$(git rev-parse --abbrev-ref HEAD)"

echo "=== Rebuilding TS bot ==="
cd apex-predator && npm run build && cd ..

echo "=== Rebuilding Go bot ==="
cd arbitrage && go build -o arb-bot ./... && cd ..

echo "=== Reloading PM2 ==="
pm2 reload ecosystem.config.js --update-env

echo "✅ Update complete"
pm2 ls
