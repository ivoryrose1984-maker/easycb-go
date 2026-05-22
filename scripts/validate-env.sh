#!/usr/bin/env bash
# Checks that all required env vars are set before starting the bots.
# Exits 1 if anything is missing so start.sh won't launch broken bots.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

ok=true

check_var() {
  local file="$1" var="$2" required="${3:-true}"
  local val
  val=$(grep -E "^${var}=" "$file" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  if [[ -z "$val" || "$val" == 0x* && ${#val} -lt 10 ]]; then
    if [[ "$required" == "true" ]]; then
      echo "  ✗ $var — MISSING (required)"
      ok=false
    else
      echo "  - $var — not set (optional)"
    fi
  else
    # Mask private key in output
    if [[ "$var" == *PRIVATE_KEY* || "$var" == *TOKEN* || "$var" == *KEY* ]]; then
      echo "  ✓ $var = ${val:0:8}…"
    else
      echo "  ✓ $var = $val"
    fi
  fi
}

# ─── TypeScript bot ───────────────────────────────────────────────────────────
TS_ENV="$ROOT/apex-predator/.env"
echo ""
echo "── apex-predator (.env) ─────────────────────"
if [[ ! -f "$TS_ENV" ]]; then
  echo "  ✗ .env file missing — copy from .env.example"
  ok=false
else
  check_var "$TS_ENV" ALCHEMY_WSS_URL
  check_var "$TS_ENV" PRIVATE_KEY
  check_var "$TS_ENV" APEX_FLASH_LOAN_BASE
  check_var "$TS_ENV" CHAIN_ID
  check_var "$TS_ENV" TELEGRAM_BOT_TOKEN false
  check_var "$TS_ENV" TELEGRAM_CHAT_ID false
  check_var "$TS_ENV" SUPABASE_URL false
  check_var "$TS_ENV" SUPABASE_ANON_KEY false
fi

# ─── Go bot ───────────────────────────────────────────────────────────────────
GO_ENV="$ROOT/arbitrage/.env"
echo ""
echo "── arbitrage (.env) ─────────────────────────"
if [[ ! -f "$GO_ENV" ]]; then
  echo "  ✗ .env file missing — copy from .env.example"
  ok=false
else
  check_var "$GO_ENV" ARB_PRIVATE_KEY
  check_var "$GO_ENV" ARB_RPC_URLS
  check_var "$GO_ENV" ARB_FLASH_LOAN_CONTRACT
  check_var "$GO_ENV" ARB_DRY_RUN
  check_var "$GO_ENV" ARB_TELEGRAM_BOT_TOKEN false
  check_var "$GO_ENV" ARB_TELEGRAM_CHAT_ID false
  check_var "$GO_ENV" ARB_SUPABASE_URL false
  check_var "$GO_ENV" ARB_SUPABASE_KEY false
fi

echo ""
if [[ "$ok" == "true" ]]; then
  echo "✅ All required env vars present"
  exit 0
else
  echo "❌ Fix missing vars above, then re-run"
  exit 1
fi
