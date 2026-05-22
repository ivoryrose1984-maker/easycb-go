#!/usr/bin/env bash
# Quick health check — shows bot status, recent profits, last log lines
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

echo ""
echo "══════════════════════════════════════════════"
echo "  ARB BOT STATUS"
echo "══════════════════════════════════════════════"

# PM2 status
pm2 list 2>/dev/null || echo "  PM2 not running"

echo ""
echo "── Recent profit events ──────────────────────"
for logfile in "$ROOT/logs/"*.log; do
  [[ -f "$logfile" ]] || continue
  name=$(basename "$logfile" .log)
  profits=$(grep -i "profit\|SUCCESS\|flash loan submitted" "$logfile" 2>/dev/null | tail -5 || true)
  if [[ -n "$profits" ]]; then
    echo "  [$name]"
    echo "$profits" | sed 's/^/    /'
  fi
done

echo ""
echo "── Last error (if any) ───────────────────────"
for errfile in "$ROOT/logs/"*-error.log; do
  [[ -f "$errfile" ]] || continue
  name=$(basename "$errfile" -error.log)
  last_err=$(tail -3 "$errfile" 2>/dev/null || true)
  if [[ -n "$last_err" ]]; then
    echo "  [$name]"
    echo "$last_err" | sed 's/^/    /'
  fi
done

echo ""
echo "  For live logs: pm2 logs"
echo "  For dashboard: check your Vercel URL"
echo "══════════════════════════════════════════════"
