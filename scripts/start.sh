#!/usr/bin/env bash
# Start both bots via PM2. Validates env vars first, builds if needed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

log()  { echo -e "\033[1;32m[START]\033[0m $*"; }
fail() { echo -e "\033[1;31m[FAIL]\033[0m $*"; exit 1; }

# ─── Validate env ─────────────────────────────────────────────────────────────
log "Validating environment…"
bash "$SCRIPT_DIR/validate-env.sh" || fail "Fix env vars above before starting"

# ─── Load Go bot .env into shell for PM2 ──────────────────────────────────────
if [[ -f "$ROOT/arbitrage/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/arbitrage/.env"
  set +a
fi

# ─── Build if binaries are stale ──────────────────────────────────────────────
log "Checking builds…"
if [[ ! -f "$ROOT/apex-predator/dist/ApexPredator.js" ]]; then
  log "Building TypeScript bot…"
  cd "$ROOT/apex-predator" && npm run build
  cd "$ROOT"
fi

if [[ ! -f "$ROOT/arbitrage/arb-bot" ]]; then
  log "Building Go bot…"
  cd "$ROOT/arbitrage" && go build -o arb-bot ./...
  cd "$ROOT"
fi

# ─── Create log directory ─────────────────────────────────────────────────────
mkdir -p "$ROOT/logs"

# ─── Start via PM2 ────────────────────────────────────────────────────────────
log "Starting bots via PM2…"
pm2 start "$ROOT/ecosystem.config.js"
pm2 save

echo ""
log "Both bots running ✅"
echo ""
echo "  Useful commands:"
echo "  pm2 logs                  # stream all logs"
echo "  pm2 logs apex-predator    # TS bot only"
echo "  pm2 logs arb-go           # Go bot only"
echo "  pm2 monit                 # live CPU/memory"
echo "  pm2 stop all              # stop everything"
echo "  bash scripts/status.sh    # quick status check"
