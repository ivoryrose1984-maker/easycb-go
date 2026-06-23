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

## Magic Numbers — Status

| File                        | Value              | Status   | Replaced with                          |
|-----------------------------|--------------------| ---------|----------------------------------------|
| dexSpreadSignal.ts          | `0.001` flash fee  | FIXED P1 | `CONFIG.FLASH_LOAN_FEE_BPS / 10_000`  |
| cbETHFairValueSignal.ts     | `0.0005` flash fee | FIXED P4 | `CONFIG.FLASH_LOAN_FEE_BPS / 10_000`  |
| aerodromeSignal.ts          | `0.001` flash fee  | FIXED P5 | `CONFIG.FLASH_LOAN_FEE_BPS / 10_000`  |
| triangularArbSignal.ts      | `0.0015` flash fee | FIXED P5 | `CONFIG.FLASH_LOAN_FEE_BPS / 10_000`  |
| cbETHFairValueSignal.ts     | `10+5` bps buffers | FIXED P4 | `CONFIG.LATENCY_BUFFER_BPS + FAILURE_BUFFER_BPS` |
| cbETHFairValueSignal.ts     | `0.0003` gas ETH   | OPEN     | derive from gasForecaster (future)     |
| dexSpreadSignal.ts          | `250, 10` slippage | OPEN     | named constant (future)                |

---

## Bug Ledger

### BUG-01: Anomaly spreads counted as skips — FIXED Phase 1
- **Files**: `dexSpreadSignal.ts`, `apexPairScanner.ts`, `captureTelemetry.ts`
- **Symptom**: USDbC/WETH=-7828bps, DAI/WETH=-9577bps etc. tagged as `filter_result:"skip"`, inflating skip counts and polluting skip-reason breakdown and median-bps
- **Root cause**: No sanity gate; thin/absent pool liquidity → near-zero quotes → valid-but-meaningless negative spread
- **Fix**: Gate at |spread|>2000bps → `filter_result:"anomaly"`, separate from intentional skips
- **Test**: `capture.test.ts` — anomaly accounting (3 tests)

### BUG-02: netProfitUsd deducts phantom flash loan fee — FIXED Phase 1/4/5
- **Files**: `dexSpreadSignal.ts` (P1), `cbETHFairValueSignal.ts` (P4), `aerodromeSignal.ts` (P5), `triangularArbSignal.ts` (P5)
- **Symptom**: `grossUsd * 0.001` (or 0.0005/0.0015) deducted even though Balancer flash loans are free
- **Root cause**: Hardcoded fee fraction instead of `CONFIG.FLASH_LOAN_FEE_BPS / 10_000`
- **Fix**: All four signals now use config-derived value (= 0)
- **Test**: `math.test.ts` — "all four signals use the same flash loan fee formula"

### BUG-03: unhandledRejection → process.exit(1) too aggressive — FIXED Phase 2
- **File**: `dry-run.ts`
- **Symptom**: Any background async error (CEX feed reconnect, timer callbacks) kills the process; contributed to 217 PM2 restarts
- **Root cause**: Catch-all rejection handler unconditionally exited
- **Fix**: Log full stack and continue; exit only on `uncaughtException` (synchronous crash)

### BUG-04: ENABLE_BINANCE defaults true despite Hetzner geo-block — FIXED Phase 3
- **File**: `config.ts`
- **Symptom**: `[CEX] Binance geo-blocked (HTTP 451)` on every reconnect; useless retry spam
- **Root cause**: `flag('ENABLE_BINANCE', true)`
- **Fix**: Default false; guard `getCexFeed()` behind the flag

### BUG-05: Telegram chat_id not validated at startup — FIXED Phase 3
- **File**: `telegramAlert.ts`
- **Symptom**: Bad chat_id discovered only at send time, error logged per message
- **Root cause**: `getMe()` validates bot token only, not the chat_id
- **Fix**: Send probe message at startup; on failure disable all alerts and log WARN once

### BUG-06: Disabled strategies indistinguishable from broken in report — FIXED Phase 4
- **Files**: `reportGenerator.ts`, `generate-report.ts`, `RunReport.ts`
- **Symptom**: `apex.aerodrome_spread` shows 0/0 scans — looks identical to "erroring silently"
- **Root cause**: No report-time check of `ENABLE_*` flags
- **Fix**: `StrategyStats.disabled` field set when flag is false; report shows `[DISABLED: FLAG=false]`

### BUG-07: cbETH cost model magic numbers — FIXED Phase 4
- **File**: `cbETHFairValueSignal.ts:167`
- **Symptom**: `+ 10 + 5` bps buffer constants not traceable to any config value
- **Root cause**: Hardcoded; correct values match spec but unmaintainable
- **Fix**: `CONFIG.LATENCY_BUFFER_BPS + CONFIG.FAILURE_BUFFER_BPS`
- **Test**: `math.test.ts` — "totalCosts uses named config buffers"

---

## npm audit status (Phase 6)

11 vulnerabilities (9 moderate, 2 critical) in `ethers`'s bundled `ws` package (GHSA-58qx-3vcg-4xpx).
Fix requires `--force` which downgrades to ethers@5 — a breaking API change. No action taken.
Tracked; will reassess when ethers v6 ships a patched ws version.

---

*Last updated: Phase 6 complete — all 84 tests passing, TypeScript clean*
