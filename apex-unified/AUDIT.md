# Apex Unified — Audit & Remediation Log

## Data Flow Diagram

```
WebSocket (Alchemy) ~2s blocks
  └─► ResilientWsProvider.on('block', blockNum)
        └─► handlerActive guard (drops block if previous scan still running)
              │
              ├─► getEthPrice()                     [cached 12s, HTTP provider]
              │     └─► UNI_QUOTER WETH→USDC
              │           fallback: 3_000_000_000 (6-dec USDC = $3000)
              │
              └─► Promise.all([4 scanners])
                    │
                    ├─► CbEthFairValueScanner
                    │     └─► CbEthFairValueSignal.scan()
                    │           ├─► Chainlink cbETH/USD ÷ ETH/USD → rate (18-dec ratio)
                    │           │     cache: 25h, fallback: hardcoded 1.065 (logs ERROR)
                    │           ├─► UNI_QUOTER cbETH→WETH (3.33 cbETH probe, 18-dec)
                    │           ├─► grossEdgeBps = (dexRate - fairRate) / fairRate × 10000
                    │           └─► netEdgeBps = gross - (gas + slippage + fee + buffers) bps
                    │
                    ├─► ApexPairScanner (13 pairs)
                    │     └─► DexSpreadSignal.scan() per pair
                    │           ├─► Probes: WETH=3 ETH (18-dec), DAI=5000 DAI (18-dec),
                    │           │           others=5000 (6-dec USDC/USDT/USDbC)
                    │           ├─► Phase 1: buy quotes  tokenIn→tokenOut (8 calls)
                    │           ├─► Phase 2: sell quotes tokenOut→tokenIn (≤8 calls, skip same pool)
                    │           ├─► spreadBpsProbe = (sellOut - loanIn) × 10000 / loanIn
                    │           ├─► [ANOMALY GATE] |spread| > 2000bps → filter_result:"anomaly"
                    │           ├─► [if ≥ MIN_PROFIT_BPS=20] liquidity check at 10× (2 calls)
                    │           ├─► [if passes liq check] ternarySearchSize 8 iters (16 calls)
                    │           └─► finalSpread = (finalSellOut - finalLoan) × 10000 / finalLoan
                    │
                    ├─► ApexTriangularScanner (22 paths)
                    │     └─► TriangularArbSignal.scan() per path
                    │           └─► UNI_QUOTER 3 sequential hops (USDC round-trip, 6-dec)
                    │
                    └─► AerodromeScanner [DISABLED on VPS: ENABLE_AERODROME_SIGNAL=false]
                          └─► AerodromeSignal.scan() (Aerodrome V1 vs Uni V3)
              │
              ├─► captureDetected(filterResult:"pass"|"skip"|"anomaly")
              │     └─► fire-and-forget → logs/capture-YYYY-MM-DD.jsonl
              │
              └─► [if pass] executeDryRun()
                    ├─► logOpportunity() → logs/unified-opportunities-YYYY-MM-DD.jsonl
                    └─► alertOpportunity() → Telegram [60s cooldown]

npm run report
  └─► generate72HourReport()
        └─► readCaptureStats(dates[], sinceMs=CLEAN_DATA_SINCE)   ← D2 single source
              └─► logs/capture-YYYY-MM-DD.jsonl
              └─► filter: ts_ms >= CLEAN_DATA_SINCE (default 2026-06-12T16:05:00Z)
        └─► buildStatsFromCapture() per strategy
        └─► liveReadinessScore() → score 0–100 + blockers list
        └─► logs/report-{runId}.json
```

## Unit Assumptions per Token

| Token  | Decimals | Probe used          | USD conversion          |
|--------|----------|---------------------|-------------------------|
| WETH   | 18       | parseEther('3')     | × ethPriceUsd / 1e18    |
| DAI    | 18       | parseUnits('5000',18)| / 1e18 (≈$1 stablecoin) |
| USDC   | 6        | 5_000 × 1_000_000n  | / 1e6                   |
| USDT   | 6        | same as USDC        | / 1e6                   |
| USDbC  | 6        | same as USDC        | / 1e6                   |
| cbETH  | 18       | 3.33 cbETH (18-dec) | × ethRate × ethPrice    |
| cbBTC  | 8        | same as USDC probe  | not converted (todo)    |
| AERO   | 18       | same as USDC probe  | not converted           |

## Magic Numbers Table

| File                        | Line | Value              | Should be                    |
|-----------------------------|------|--------------------|------------------------------|
| dexSpreadSignal.ts          | 297  | `0.001` (hardcoded)| `CONFIG.FLASH_LOAN_FEE_BPS/10000` |
| cbETHFairValueSignal.ts     | 167  | `5` (slippage bps) | `CONFIG.LATENCY_BUFFER_BPS`  |
| cbETHFairValueSignal.ts     | 167  | `10` (safety buf)  | `2 × CONFIG.LATENCY_BUFFER_BPS` (CLAUDE.md says 10bps) |
| cbETHFairValueSignal.ts     | 167  | `5` (revert res)   | `CONFIG.FAILURE_BUFFER_BPS`  |
| cbETHFairValueSignal.ts     | 164  | `0.0003` (gasEth)  | derive from gasForecaster    |
| dexSpreadSignal.ts          | 299  | `250, 10` (slip)   | config or named constant     |
| dry-run.ts                  | 199  | `50` (log interval)| named constant               |

---

## Bug Ledger

### BUG-01: Anomaly spreads counted as skips (Phase 1)
- **File**: `dexSpreadSignal.ts`, `apexPairScanner.ts`, `captureTelemetry.ts`
- **Symptom**: USDbC/WETH=-7828bps, DAI/WETH=-9577bps, USDC/cbETH=-9261bps, etc. tagged as `filter_result:"skip"`, inflating skip counts and polluting skip-reason breakdown + median-bps
- **Root cause**: No sanity gate on spread magnitude; thin/absent pool liquidity causes near-zero quotes → valid-but-meaningless negative spread
- **Fix**: Gate at |spreadBpsProbe|>2000bps → `filter_result:"anomaly"`, distinct from skip
- **Commit**: Phase 1

### BUG-02: netProfitUsd deducts phantom 10bps flash loan fee (Phase 1)
- **File**: `dexSpreadSignal.ts:297`
- **Symptom**: `grossUsd * 0.001` deducted even though Balancer flash loans are free (`FLASH_LOAN_FEE_BPS=0`)
- **Root cause**: Hardcoded `0.001` instead of `CONFIG.FLASH_LOAN_FEE_BPS / 10_000`
- **Fix**: Replace with config-derived value
- **Commit**: Phase 1

### BUG-03: unhandledRejection → process.exit(1) too aggressive (Phase 2)
- **File**: `dry-run.ts:30-33`
- **Symptom**: Any background async error (CEX feed reconnect, gas forecaster, timer callbacks) kills the process; contributes to PM2 restart count
- **Root cause**: Catch-all rejection handler always exits
- **Fix**: Log full stack, attempt graceful shutdown; exit only on truly unknown/fatal rejections
- **Commit**: Phase 2

### BUG-04: ENABLE_BINANCE defaults true despite Hetzner geo-block (Phase 3)
- **File**: `config.ts`
- **Symptom**: `[CEX] Binance geo-blocked (HTTP 451)` on every reconnect; useless retry spam
- **Root cause**: `flag('ENABLE_BINANCE', true)` — should default false
- **Fix**: `flag('ENABLE_BINANCE', false)`; guard `getCexFeed()` behind flag
- **Commit**: Phase 3

### BUG-05: Telegram chat_id not validated at startup (Phase 3)
- **File**: `telegramAlert.ts`
- **Symptom**: Bad chat_id discovered only at send time; logs one error per message for hours
- **Root cause**: `getMe()` validates bot token only, not chat_id
- **Fix**: Send probe message at startup; on failure disable and log WARN once
- **Commit**: Phase 3

### BUG-06: Disabled strategies indistinguishable from broken in report (Phase 4)
- **File**: `reportGenerator.ts`, `generate-report.ts`
- **Symptom**: aerodrome_spread shows 0/0 scans — looks identical to "no opportunities" or "erroring silently"
- **Root cause**: No report-time check of enable flags
- **Fix**: Mark strategies with 0 detected AND enable flag false as `DISABLED(reason)`
- **Commit**: Phase 4

### BUG-07: cbETH cost model uses magic numbers instead of config (Phase 4)
- **File**: `cbETHFairValueSignal.ts:167`
- **Symptom**: `10` and `5` bps buffers not traceable to any config value
- **Root cause**: Hardcoded constants; safe (correct values match CLAUDE.md spec) but unmaintainable
- **Fix**: Named constants referencing CONFIG
- **Commit**: Phase 4

### BUG-08: Dead import readOpportunities in reportGenerator (Phase 5)
- **File**: `reportGenerator.ts`
- **Symptom**: Unused import lingers after WO-3 cleanup
- **Root cause**: Import not removed when buildStats() was deleted
- **Fix**: Remove import
- **Commit**: Phase 5

---

*Last updated: Phase 0 — recon only, no code changes*
