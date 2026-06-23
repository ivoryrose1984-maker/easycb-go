#!/usr/bin/env bash
# One-shot VPS setup: Ubuntu 22.04 fresh → Apex Unified ready to run
# Run as root: bash deploy/setup.sh
set -euo pipefail

REPO="https://github.com/ivoryrose1984-maker/easycb-go.git"
BRANCH="claude/new-session-ao4nr"
INSTALL_DIR="/opt/easycb-go"
NODE_MAJOR="22"

log() { echo -e "\033[1;32m[SETUP]\033[0m $*"; }

log "[1/6] System packages"
apt-get update -qq
apt-get install -y -qq git curl wget build-essential ca-certificates gnupg lsb-release

log "[2/6] Node ${NODE_MAJOR} + PM2"
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -
  apt-get install -y nodejs
fi
npm install -g pm2 --silent
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

log "[3/6] Clone repo"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull origin "$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

log "[4/6] Install dependencies"
cd apex-unified
npm install --silent
npm run build
cd ..

log "[5/6] Create log directory"
mkdir -p /var/log/apex

log "[6/6] Done"
echo ""
echo "=============================================="
echo "  BUILD COMPLETE — Apex Unified ready"
echo "=============================================="
echo ""
echo "NEXT: Create apex-unified/.env (see ENV_MASTER_TEMPLATE.txt), then:"
echo "   bash deploy/start-dryrun.sh"
