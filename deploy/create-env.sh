#!/usr/bin/env bash
# Interactive wizard: creates apex-unified/.env from user input.
# Values are NOT echoed to the terminal.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo ""
echo "=== Apex Unified — Env Setup Wizard ==="
echo "Values will NOT be shown as you type. Press Enter after each."
echo ""

read -rsp "Alchemy WSS URL (wss://base-mainnet.g.alchemy.com/v2/YOUR_KEY): " ALCHEMY_WSS; echo
read -rsp "TELEGRAM_BOT_TOKEN: " TG_TOKEN; echo
read -rp  "TELEGRAM_CHAT_ID: " TG_CHAT_ID
read -rp  "MONITOR_ADDRESS (your wallet address, or press Enter to skip): " MONITOR_ADDR

cat > "${INSTALL_DIR}/apex-unified/.env" <<EOF
ALCHEMY_WSS_URL=${ALCHEMY_WSS}
CHAIN_ID=8453
DRY_RUN=true
ALLOW_LIVE=false
TELEGRAM_BOT_TOKEN=${TG_TOKEN}
TELEGRAM_CHAT_ID=${TG_CHAT_ID}
MONITOR_ADDRESS=${MONITOR_ADDR}
APEX_FLASH_LOAN_ADDRESS=0x0000000000000000000000000000000000000000
ENABLE_DEX_SPREAD_SIGNAL=true
ENABLE_TRIANGULAR_SIGNAL=true
ENABLE_CBETH_SIGNAL=true
ENABLE_AERODROME_SIGNAL=true
ENABLE_CEX_CONTEXT=true
MIN_NET_EDGE_BPS=5
NODE_ENV=production
EOF

echo ""
echo "apex-unified/.env written"
echo ""
echo "Next: bash deploy/start-dryrun.sh"
