#!/usr/bin/env bash
# Interactive wizard: creates both .env files from user input.
# Sensitive values are never echoed to the terminal.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo ""
echo "=== Env Setup Wizard ==="
echo "Values will NOT be shown as you type. Press Enter after each."
echo ""

# ── TS bot ──────────────────────────────────────────────────────────────
echo "--- apex-predator (.env.testnet) ---"

read -rp  "Alchemy WSS URL (wss://base-mainnet.g.alchemy.com/v2/YOUR_KEY): " ALCHEMY_WSS
read -rsp "Wallet PRIVATE_KEY (0x...): " PRIVATE_KEY; echo
read -rp  "SUPABASE_URL (https://YOUR_PROJECT.supabase.co): " SUPABASE_URL
read -rsp "SUPABASE_ANON_KEY: " SUPABASE_ANON_KEY; echo
read -rsp "TELEGRAM_BOT_TOKEN (or press Enter to skip): " TG_TOKEN; echo
read -rp  "TELEGRAM_CHAT_ID (or press Enter to skip): " TG_CHAT_ID

cat > "${INSTALL_DIR}/apex-predator/.env.testnet" <<EOF
ALCHEMY_WSS_URL=${ALCHEMY_WSS}
PRIVATE_KEY=${PRIVATE_KEY}
DRY_RUN=true
APEX_FLASH_LOAN_BASE=0x0000000000000000000000000000000000000000
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
TELEGRAM_BOT_TOKEN=${TG_TOKEN}
TELEGRAM_CHAT_ID=${TG_CHAT_ID}
EOF

echo "✅ apex-predator/.env.testnet written"

# ── Go bot ───────────────────────────────────────────────────────────────
echo ""
echo "--- arbitrage (.env) ---"
echo "(RPC URL is the HTTPS version of the same Alchemy key)"

ALCHEMY_HTTP="${ALCHEMY_WSS/wss:\/\//https://}"

cat > "${INSTALL_DIR}/arbitrage/.env" <<EOF
ARB_RPC_URLS=${ALCHEMY_HTTP}
ARB_DRY_RUN=true
ARB_SUPABASE_URL=${SUPABASE_URL}
ARB_SUPABASE_KEY=${SUPABASE_ANON_KEY}
ARB_LOG_LEVEL=info
ARB_TELEGRAM_BOT_TOKEN=${TG_TOKEN}
ARB_TELEGRAM_CHAT_ID=${TG_CHAT_ID}
EOF

echo "✅ arbitrage/.env written"
echo ""
echo "Both env files created. Now run:"
echo "   bash deploy/start-dryrun.sh"
