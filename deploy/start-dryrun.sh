#!/usr/bin/env bash
# Start Apex Unified in dry-run mode via PM2.
# Run from repo root: bash deploy/start-dryrun.sh
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$INSTALL_DIR"

fail() { echo "ERROR: $*" >&2; exit 1; }

# ── Pre-flight checks ──────────────────────────────────────────────────────
[ -f "apex-unified/.env" ]                          || fail "Missing apex-unified/.env — create it first (see ENV_MASTER_TEMPLATE.txt)"
[ -f "apex-unified/dist/scripts/dry-run.js" ]       || fail "Not built — run: cd apex-unified && npm run build"
grep -q "DRY_RUN=true"     apex-unified/.env        || fail "DRY_RUN must be true in apex-unified/.env"
grep -q "ALLOW_LIVE=false" apex-unified/.env        || fail "ALLOW_LIVE must be false in apex-unified/.env"

echo "Pre-flight checks passed"

# ── Create log directory ───────────────────────────────────────────────────
mkdir -p /var/log/apex

# ── Start via PM2 ─────────────────────────────────────────────────────────
pm2 delete apex-unified 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

echo ""
echo "=============================================="
echo "  Apex Unified — DRY RUN started"
echo "=============================================="
echo ""
echo "Stream logs:   pm2 logs apex-unified"
echo "Live stats:    pm2 monit"
echo "Stop:          pm2 stop apex-unified"
echo "Status:        pm2 ls"
