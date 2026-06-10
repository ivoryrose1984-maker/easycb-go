# easycb-go — Project Context for Claude

## What this repo is

Three-layer unified arbitrage bot targeting Base L2 (chain 8453).
**Atlas thinks. Grok sees. Apex executes.**

- **Apex** = execution engine (flash loans, DEX spread, triangular arb, ternary sizing)
- **Grok** = signal quality layer (cbETH fair-value, Binance CEX feed, dedup, JSONL audit)
- **Atlas** = research layer (backtesting, replay engine, 72-hour reports, parameter optimization)

**CRITICAL SEPARATION:** Ryvynn.live is a completely separate project. Do not include Ryvynn.live in any bot logic, architecture, data model, or execution system in this repo. Ever.

---

## Active module: apex-unified

Located at `/apex-unified/`. This is the live system. The older modules (`apex-predator/`, `grok-bot/`, `arbitrage/`) are legacy — do not modify them.

### Directory structure
```
apex-unified/src/
  core/        config, safety, runContext, logger, jsonlLogger, dedup, clock, rpcHealth
  signals/     cbETHFairValueSignal, dexSpreadSignal, triangularArbSignal, aerodromeSignal, cexContextSignal
  scanners/    cbETHFairValueScanner, apexPairScanner, apexTriangularScanner, aerodromeScanner
  execution/   dryRunExecutor, liveExecutor, gasForecaster, flashLoanPlanner, routePlanner, bundlePlanner
  risk/        circuitBreaker, lossLimits, strategyKillSwitch, exposureLimits, networkMutex
  research/    replayEngine, backtester, opportunityScorer, reportGenerator, parameterOptimizer
  infrastructure/ telegramAlert
  contracts/   ApexFlashLoan.sol
  types/       Opportunity, StrategyResult, ExecutionPlan, RiskDecision, RunReport
  scripts/     dry-run.ts, generate-report.ts, replay.ts, deploy-contract.ts
  __tests__/   setup.ts, core.test.ts, math.test.ts, safety.test.ts  (27 tests)
```

### Strategy IDs
- `apex.dex_spread` — DEX cross-fee-tier spread arb (9 pairs, Uni V3 + PancakeSwap V3)
- `apex.triangular` — 3-hop USDC cycles (18 static paths, max ~54 RPC calls/block)
- `apex.aerodrome_spread` — Aerodrome Solidly AMM cross-DEX arb
- `grok.cbeth_fair_value` — cbETH price vs exchangeRate() fair value
- `atlas.replay` — offline replay from JSONL logs
- `atlas.backtest` — parameter optimization

### Key contracts (Base mainnet)
- cbETH: `0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22`
- Uni V3 Quoter V2: `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`
- Uni V3 Router: `0x2626664c2603336E57B271c5C0b26F421741e481`
- PancakeSwap V3 Quoter: `0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997`
- PancakeSwap V3 Router: `0x1b81D678ffb9C0263b24A97847620C99d213eB14`
- Balancer Vault: `0xBA12222222228d8Ba445958a75a0704d566BF2C8`
- ApexFlashLoan.sol — deployed via `scripts/deploy-contract.ts`; both routers whitelisted via `setRouter()`

### Cost model (baked into signals)
- Gas: ~0.0003 ETH per trade (250k gas × ~1 gwei on Base L2) ≈ $0.90 at $3000/ETH
- Slippage: 5 bps (2-hop) / 15 bps (3-hop triangular)
- DEX fee: variable (fee tier / 100)
- Safety buffer: 10 bps
- Revert reserve: 5 bps
- Min net edge gate: 5 bps (configurable via MIN_NET_EDGE_BPS)
- ETH price: live-quoted from Uni V3 WETH→USDC each block; fallback 3_000_000_000 (6-dec USDC = $3000)

---

## Safety — non-negotiable

```
DRY_RUN=true         # default — must be explicitly set false to change
ALLOW_LIVE=false     # default — must be explicitly set true to change
```

- `assertDryRunMode()` is called at the top of `dry-run.ts` — throws if either flag is wrong
- `requireLiveAllowed()` is the first line of `liveExecutor.ts` — throws during dry run
- No private key is needed or used during dry run
- `.env` is gitignored — never commit secrets
- No sandwiching, no frontrunning, no user-targeted exploitation
- Only market-neutral arbitrage using public AMM state

---

## Infrastructure

- **VPS:** Hetzner at `5.161.113.63` (root access)
- **Chain:** Base L2 (chainId 8453), ~2s blocks, Coinbase sequencer
- **RPC:** Alchemy WSS (env var: `ALCHEMY_WSS_URL`)
- **Telegram alerts:** BOT_TOKEN + CHAT_ID (env vars only, never hardcoded)
- **Logs:** JSONL files at `apex-unified/logs/` — `unified-opportunities-YYYY-MM-DD.jsonl`
- **Network mutex:** `.locks/chain-8453.lock` — prevents competing instances
- **Screen session name:** `apex-unified`
- **Log file:** `/var/log/apex/unified.log`

---

## Deploy workflow

`.github/workflows/deploy-dryrun.yml` — manual trigger only.
- Branch: `claude/new-session-ao4nr`
- Required GitHub secrets: `HETZNER_ROOT_PASSWORD`, `ALCHEMY_WSS_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- No `WALLET_PRIVATE_KEY` needed for dry run
- Trigger: Actions tab → "Deploy Apex Unified — Dry-Run" → Run workflow → type `deploy-dry-run`

---

## Run commands

```bash
npm run dry-run       # build + start scanning (DRY_RUN=true enforced)
npm run report        # generate 72-hour report from JSONL logs
npm run replay 2024-01-15   # replay a specific date
```

---

## Phase status

| Phase | Status |
|---|---|
| Phase 1: Architecture + code | DONE — TypeScript clean, 27 tests passing, two audit rounds resolved |
| Phase 2: Deploy to VPS | DONE — bot live on Hetzner via PM2, Alchemy paid plan, Chainlink cbETH rate confirmed (`source=chainlink`) |
| Phase 3: 72-hour dry run | IN PROGRESS — clean run started 2026-06-10 ~12:15 UTC after Alchemy 429 fix; prior data (Jun 8–9) partially contaminated by hardcoded cbETH rate + repeated WS crashes |
| Phase 4: Report + live readiness | NOT STARTED — needs 48h+ clean data through US/EU market-open windows |

Live execution requires: Phase 3 complete + readiness score ≥70 + rotate all credentials + deploy ApexFlashLoan.sol + fresh funded wallet (~0.05 ETH on Base).

### Resolved audit issues (Phase 1)
All of the following were identified and fixed before dry run:
1. Circuit breaker set flag but never halted — now kills all strategies, awaits Telegram alert, `process.exit(1)`
2. `flashLoanSource` field name mismatch (contract expects router address) — renamed to `routerAddress` throughout
3. `buildExecutionPlan()` was missing — every live tx would revert with no slippage floor; now built with `minAmountOut = sellQuote * 995n / 1000n`
4. PancakeSwap V3 Router not whitelisted in `ApexFlashLoan.sol` — `deploy-contract.ts` now calls `setRouter()` for both routers post-deploy
5. WETH profit reported as phantom trillions — fixed WETH denomination: `usdcToUsd(grossProfitRaw * ethPriceUsd / 10n**18n)`
6. Aerodrome scanner lacked ETH price for WETH→USD conversion — `ethPriceUsd` now threaded through scanner chain
7. Triangular scanner making ~540 RPC calls/block — replaced with 18-path static whitelist (~54 calls/block max)
8. Block handler accumulation when scan > 2s — `handlerActive` flag prevents pile-up
9. Circuit breaker Telegram alert silently dropped (60s cooldown) — `alertCircuitBreaker()` bypasses cooldown, returns `Promise<void>`
10. CI tested only legacy modules — added `build-apex-unified` and `compile-contracts` jobs
11. Triangular `netProfitUsd` used hardcoded $0.90 gas — now dynamic via `ethPriceUsd`
12. Deploy workflow missing `ENABLE_AERODROME_SIGNAL=true` and wrong JSONL pattern — both fixed

### Resolved production issues (Phase 2/3, June 2026)
13. cbETH used hardcoded 1.065 rate (Chainlink cbETH/ETH feed doesn't exist on Base) — now derives rate from Chainlink cbETH/USD (`0xd7818272B9e248357d13057AAb0B417aF31E817d`) ÷ ETH/USD (`0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70`); returns null (no fake opps) if all sources fail. The 1,392 cbETH "opportunities" from night 1 were artifacts of the hardcoded rate — discard that data
14. WS `RangeError: Invalid WebSocket frame` + `429` crash loop (Alchemy free-tier throttle) — `ws.on('error'/'close')` handlers in `rpcHealth.ts` trigger immediate reconnect; 3-failures-in-60s switches to `FALLBACK_RPC_URL`; root cause resolved by Alchemy paid plan
15. Telegram `can't parse entities` (underscores in strategy IDs broke Markdown) — switched to HTML parse_mode with `esc()` helper
16. Circuit breaker halted on a single balance read — now requires 3 consecutive breaches (`GRACE_BLOCKS=3`), counter resets on recovery
17. `liveExecutor.ts` broadcast without simulating — now `executeArbitrage.staticCall()` before signing; reverts are caught pre-broadcast, no gas spent
18. WS keepalive `setInterval` leaked on every reconnect (pinging dead sockets, accumulating timers) — now cleared via `ws.on('close')`; reconnect trigger also debounced so error+close can't double-fire
19. Daily loss counter reset on local-time midnight — now resets on UTC day boundary (matches chain time and JSONL logs)

### Known data caveats
- `apex.aerodrome_spread`: 0 profitable out of 10,775 scans (Jun 8–9) — disabled on VPS (`ENABLE_AERODROME_SIGNAL=false`) pending investigation
- Persistent DAI/WETH 178bps spread repeating across consecutive blocks is suspect: real arbs vanish in 1–2 blocks; a spread that persists usually means thin liquidity the quote can't actually fill at size. Treat repeated same-route signals as ONE opportunity, not thousands, when estimating revenue
- VPS `.env` had `APEX_FLASH_LOAN_ADDRESS` (wrong name; code reads `APEX_FLASH_LOAN_BASE`)

---

## Credentials note

All credentials currently in use are throwaway — will be rotated before any live execution.
Never print, echo, log, store, commit, or reveal secret values. Reference env var names only.
