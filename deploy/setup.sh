#!/usr/bin/env bash
# One-shot VPS setup: Ubuntu 22.04 fresh → both bots built and ready
# Run as root: bash setup.sh
set -euo pipefail

REPO="https://github.com/ivoryrose1984-maker/easycb-go.git"
BRANCH="claude/new-session-ao4nr"
INSTALL_DIR="/opt/easycb-go"
GO_VERSION="1.24.7"
NODE_MAJOR="22"

echo "=== [1/7] System packages ==="
apt-get update -qq
apt-get install -y -qq git curl wget build-essential ca-certificates gnupg lsb-release

echo "=== [2/7] Node ${NODE_MAJOR} + PM2 ==="
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -
  apt-get install -y nodejs
fi
npm install -g pm2 --silent
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

echo "=== [3/7] Go ${GO_VERSION} ==="
if ! command -v go &>/dev/null; then
  wget -q "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -O /tmp/go.tar.gz
  rm -rf /usr/local/go
  tar -C /usr/local -xzf /tmp/go.tar.gz
  rm /tmp/go.tar.gz
  echo 'export PATH=$PATH:/usr/local/go/bin' >> /root/.bashrc
  export PATH=$PATH:/usr/local/go/bin
fi
go version

echo "=== [4/7] Clone repo ==="
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull origin "$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

echo "=== [5/7] Build TS bot (apex-predator) ==="
cd apex-predator
npm install --silent
npm run build
cd ..

echo "=== [6/7] Build Go bot (arbitrage) ==="
cd arbitrage
export PATH=$PATH:/usr/local/go/bin
go build -o arb-bot ./...
cd ..

echo "=== [7/7] Create log directory ==="
mkdir -p logs

echo ""
echo "=============================================="
echo "  BUILD COMPLETE — both bots compiled"
echo "=============================================="
echo ""
echo "NEXT: Create your .env files, then run:"
echo "   bash deploy/start-dryrun.sh"
echo ""
echo "Env files needed:"
echo "   ${INSTALL_DIR}/apex-predator/.env.testnet"
echo "   ${INSTALL_DIR}/arbitrage/.env"
echo ""
echo "Run this to create them interactively:"
echo "   bash deploy/create-env.sh"
