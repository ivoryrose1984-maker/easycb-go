#!/usr/bin/env bash
# Pull latest code, rebuild both bots, and restart with zero downtime.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

log()  { echo -e "\033[1;32m[UPDATE]\033[0m $*"; }

log "Pulling latest from GitHub…"
git pull origin claude/new-session-ao4nr

log "Rebuilding TypeScript bot…"
cd "$ROOT/apex-predator" && npm install --silent && npm run build
cd "$ROOT"

log "Rebuilding Go bot…"
cd "$ROOT/arbitrage" && go build -o arb-bot ./...
cd "$ROOT"

log "Restarting bots…"
pm2 restart ecosystem.config.js
pm2 save

log "Update complete ✅"
pm2 list
