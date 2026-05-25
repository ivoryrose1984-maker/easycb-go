#!/usr/bin/env bash
# Start both bots in dry-run mode via PM2.
# Run from repo root: bash deploy/start-dryrun.sh
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$INSTALL_DIR"

# ── Pre-flight checks ─────────────────────────────────────────────────────

fail() { echo "❌ $*" >&2; exit 1; }

[ -f "apex-predator/.env.testnet" ] || fail "Missing apex-predator/.env.testnet — run deploy/create-env.sh first"
[ -f "arbitrage/.env" ]             || fail "Missing arbitrage/.env — run deploy/create-env.sh first"
[ -f "apex-predator/dist/ApexPredator.js" ] || fail "TS bot not built — run: cd apex-predator && npm run build"
[ -f "arbitrage/arb-bot" ]          || fail "Go bot not built — run: cd arbitrage && go build -o arb-bot ./..."

grep -q "DRY_RUN=true"     apex-predator/.env.testnet || fail "DRY_RUN must be true in apex-predator/.env.testnet"
grep -q "ARB_DRY_RUN=true" arbitrage/.env             || fail "ARB_DRY_RUN must be true in arbitrage/.env"

echo "✅ Pre-flight checks passed"

# ── Start via PM2 ────────────────────────────────────────────────────────

mkdir -p logs

# Stop existing instances if running
pm2 delete apex-predator 2>/dev/null || true
pm2 delete arb-go        2>/dev/null || true

pm2 start ecosystem.config.js

echo ""
echo "=============================================="
echo "  Both bots started in DRY-RUN mode"
echo "=============================================="
echo ""
echo "Stream logs:   pm2 logs"
echo "TS bot only:   pm2 logs apex-predator"
echo "Go bot only:   pm2 logs arb-go"
echo "Live stats:    pm2 monit"
echo "Stop all:      pm2 stop all"
echo ""
echo "Waiting 5s then showing live logs (Ctrl+C to exit log view)..."
sleep 5
pm2 logs --lines 50
