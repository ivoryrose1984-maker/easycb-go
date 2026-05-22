#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# One-shot VPS setup for Ubuntu 22.04 — installs everything needed to run
# both arbitrage bots. Run as root or with sudo on a fresh server.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ivoryrose1984-maker/easycb-go/claude/new-session-ao4nr/scripts/setup-vps.sh | bash
#   — OR —
#   bash scripts/setup-vps.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="https://github.com/ivoryrose1984-maker/easycb-go.git"
BRANCH="claude/new-session-ao4nr"
INSTALL_DIR="$HOME/easycb-go"
NODE_VERSION="20"
GO_VERSION="1.22.3"

log()  { echo -e "\033[1;32m[SETUP]\033[0m $*"; }
warn() { echo -e "\033[1;33m[WARN]\033[0m $*"; }
fail() { echo -e "\033[1;31m[FAIL]\033[0m $*"; exit 1; }

log "Starting full bot setup on $(hostname)"

# ─── System packages ──────────────────────────────────────────────────────────
log "Installing system packages…"
apt-get update -q
apt-get install -y -q git curl wget unzip build-essential ufw fail2ban

# ─── Node.js ──────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node -v)" != v${NODE_VERSION}* ]]; then
  log "Installing Node.js ${NODE_VERSION}…"
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y nodejs
fi
log "Node: $(node -v)  npm: $(npm -v)"

# ─── Go ───────────────────────────────────────────────────────────────────────
if ! command -v go &>/dev/null || [[ "$(go version)" != *"go${GO_VERSION}"* ]]; then
  log "Installing Go ${GO_VERSION}…"
  wget -q "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -O /tmp/go.tar.gz
  rm -rf /usr/local/go
  tar -C /usr/local -xzf /tmp/go.tar.gz
  rm /tmp/go.tar.gz
  echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
  export PATH=$PATH:/usr/local/go/bin
fi
log "Go: $(go version)"

# ─── PM2 ──────────────────────────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  log "Installing PM2…"
  npm install -g pm2 --silent
  pm2 startup systemd -u root --hp /root | tail -1 | bash || true
fi
log "PM2: $(pm2 -v)"

# ─── Clone repo ───────────────────────────────────────────────────────────────
if [[ -d "$INSTALL_DIR" ]]; then
  log "Repo exists — pulling latest…"
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull origin "$BRANCH"
else
  log "Cloning repo…"
  git clone --branch "$BRANCH" "$REPO" "$INSTALL_DIR"
fi

# ─── Build TS bot ─────────────────────────────────────────────────────────────
log "Building TypeScript bot…"
cd "$INSTALL_DIR/apex-predator"
npm install --silent
npm run build
log "TypeScript bot built ✅"

# ─── Build Go bot ─────────────────────────────────────────────────────────────
log "Building Go bot…"
cd "$INSTALL_DIR/arbitrage"
/usr/local/go/bin/go build -o arb-bot ./...
log "Go bot built ✅"

# ─── Firewall ─────────────────────────────────────────────────────────────────
log "Configuring firewall…"
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw --force enable
log "Firewall enabled ✅"

# ─── Env file check ───────────────────────────────────────────────────────────
echo ""
warn "════════════════════════════════════════════════"
warn "  SETUP COMPLETE — two manual steps remaining:"
warn ""
warn "  1. Fill in env files:"
warn "     cp $INSTALL_DIR/apex-predator/.env.example $INSTALL_DIR/apex-predator/.env"
warn "     nano $INSTALL_DIR/apex-predator/.env"
warn ""
warn "     cp $INSTALL_DIR/arbitrage/.env.example $INSTALL_DIR/arbitrage/.env"
warn "     nano $INSTALL_DIR/arbitrage/.env"
warn ""
warn "  2. Start both bots:"
warn "     cd $INSTALL_DIR && bash scripts/start.sh"
warn "════════════════════════════════════════════════"
