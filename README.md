# Apex Unified — Base L2 Arbitrage Bot

**Atlas thinks. Grok sees. Apex executes.**

Market-neutral arbitrage system targeting Base L2 (chainId 8453).

---

## Architecture

| Layer | Role |
|-------|------|
| **Apex** | Execution engine — flash loans, DEX spread, triangular arb, ternary sizing |
| **Grok** | Signal quality — cbETH fair-value, Binance CEX feed, dedup, JSONL audit |
| **Atlas** | Research — backtesting, replay engine, 72-hour reports, parameter optimization |

---

## Strategies

| ID | Description |
|----|-------------|
| `apex.dex_spread` | DEX cross-fee-tier spread arb (9 pairs, Uni V3 + PancakeSwap V3) |
| `apex.triangular` | 3-hop USDC cycles (18 static paths, ~54 RPC calls/block max) |
| `apex.aerodrome_spread` | Aerodrome Solidly AMM cross-DEX arb |
| `grok.cbeth_fair_value` | cbETH spot price vs on-chain exchangeRate() fair value |

---

## Quick Start

### Prerequisites

- Node 22+, npm
- Alchemy API key (Base mainnet WebSocket)
- Telegram bot token + chat ID (for alerts)

### Install & Build

```bash
cd apex-unified
npm install
npm run build
```

### Configure

```bash
cp apex-unified/.env.example apex-unified/.env
# Edit .env — fill in ALCHEMY_WSS_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
```

See `ENV_MASTER_TEMPLATE.txt` for all variables.

### Dry Run

```bash
cd apex-unified && npm run dry-run
```

Or via PM2 from repo root:

```bash
bash deploy/start-dryrun.sh
```

---

## Safety

Two independent gates — both must be explicitly overridden to enable live execution:

```
DRY_RUN=true       # default — set false only for live
ALLOW_LIVE=false   # default — set true only for live
```

- `assertDryRunMode()` called at startup — throws if flags are wrong
- `requireLiveAllowed()` is the first line of `liveExecutor.ts`
- No private key required or used during dry run
- Market-neutral only — no sandwiching, no frontrunning

---

## Deploy via GitHub Actions

Actions → "Deploy Apex Unified — Dry-Run" → Run workflow → type `deploy-dry-run`

Required GitHub secrets:

| Secret | Description |
|--------|-------------|
| `HETZNER_ROOT_PASSWORD` | VPS root password |
| `ALCHEMY_WSS_URL` | Alchemy WebSocket URL (Base mainnet) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Telegram chat/channel ID |

---

## Key Contracts (Base Mainnet)

| Contract | Address |
|----------|---------|
| Balancer Vault | `0xBA12222222228d8Ba445958a75a0704d566BF2C8` |
| Uni V3 Router | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| PancakeSwap V3 Router | `0x1b81D678ffb9C0263b24A97847620C99d213eB14` |
| cbETH | `0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22` |
| Uni V3 Quoter V2 | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` |

---

## Phase Status

| Phase | Status |
|-------|--------|
| Phase 1: Architecture + audit | DONE — 46 files, 27 tests passing |
| Phase 2: Deploy to VPS | READY — workflow at `.github/workflows/deploy-dryrun.yml` |
| Phase 3: 72-hour dry run | NOT STARTED |
| Phase 4: Report + live readiness | NOT STARTED — requires readiness score ≥ 70 |

---

## Structure

```
apex-unified/src/
  core/           config, safety, runContext, logger, jsonlLogger, dedup, rpcHealth
  signals/        cbETH, dexSpread, triangular, aerodrome, cexContext
  scanners/       cbETH, apexPair, apexTriangular, aerodrome
  execution/      dryRunExecutor, liveExecutor, gasForecaster, flashLoanPlanner, routePlanner
  risk/           circuitBreaker, lossLimits, strategyKillSwitch, exposureLimits, networkMutex
  research/       replayEngine, backtester, reportGenerator, parameterOptimizer
  infrastructure/ telegramAlert
  contracts/      ApexFlashLoan.sol
  scripts/        dry-run.ts, generate-report.ts, replay.ts, deploy-contract.ts
  __tests__/      27 tests

dashboard/        Real-time Next.js trading UI (Supabase realtime — Phase 4)
supabase/         Database migrations for dashboard
deploy/           VPS setup, start, and update scripts
```

---

## Infrastructure

- **VPS:** Hetzner at `5.161.113.63` (Ubuntu 22.04)
- **Chain:** Base L2 (chainId 8453), ~2s blocks
- **RPC:** Alchemy WebSocket
- **Logs:** `apex-unified/logs/` — JSONL files per strategy per day
- **Process manager:** PM2 with `stop_exit_codes: [1]` (circuit breaker stops without restart loop)

---

## Run Commands

```bash
npm run dry-run              # build + start scanning (DRY_RUN enforced)
npm run report               # generate 72-hour report from JSONL logs
npm run replay 2024-01-15    # replay a specific date
npm test                     # run 27 unit tests
```
