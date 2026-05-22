#!/usr/bin/env bash
set -euo pipefail
echo -e "\033[1;33m[STOP]\033[0m Stopping all bots…"
pm2 stop all
pm2 save
echo -e "\033[1;32m[STOP]\033[0m Both bots stopped ✅"
