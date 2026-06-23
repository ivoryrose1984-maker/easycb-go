# Apex Unified — External Audit Package

**Purpose:** Pre-dry-run code review by a second AI before live deployment.  
**Repo:** `ivoryrose1984-maker/easycb-go` branch `claude/new-session-ao4nr`  
**Module:** `/apex-unified/`  
**Language:** TypeScript (strict), Node 22, ethers v6  
**Chain:** Base L2 (chainId 8453), ~2s blocks, Coinbase sequencer  

---

## What this system does

Three-layer unified arbitrage bot. DRY RUN only — no transactions, no signing, no private key.

- **Apex** = DEX spread arb + triangular arb (execution engine)
- **Grok** = cbETH fair-value signal + Binance CEX context (signal quality)
- **Atlas** = backtester, replay engine, 72-hour reporting (research layer)

Every block (~2s), it runs 3 strategies in parallel, logs detected opportunities to JSONL, and sends Telegram alerts. After 72 hours, `generate-report` reads the logs and produces a live-readiness score.

**Safety contract:** `DRY_RUN=true` by default. `ALLOW_LIVE=false` by default. No signing path reachable without both flipped AND a private key AND the flash loan contract deployed.

---

## Architecture (40 TypeScript files)

```
src/
  core/         config.ts, safety.ts, dedup.ts, clock.ts, rpcHealth.ts,
                runContext.ts, logger.ts, jsonlLogger.ts
  signals/      cbETHFairValueSignal.ts, dexSpreadSignal.ts,
                triangularArbSignal.ts, cexContextSignal.ts
  scanners/     cbETHFairValueScanner.ts, apexPairScanner.ts, apexTriangularScanner.ts
  execution/    dryRunExecutor.ts, liveExecutor.ts, gasForecaster.ts,
                flashLoanPlanner.ts, routePlanner.ts, bundlePlanner.ts
  risk/         circuitBreaker.ts, lossLimits.ts, networkMutex.ts,
                strategyKillSwitch.ts, exposureLimits.ts
  research/     backtester.ts, opportunityScorer.ts, parameterOptimizer.ts,
                replayEngine.ts, reportGenerator.ts
  scripts/      dry-run.ts (entry point), generate-report.ts, replay.ts
```

---

## Safety gates — please verify these are airtight

### Gate 1: assertDryRunMode() in dry-run.ts line 18
```typescript
export function assertDryRunMode(): void {
  if (!CONFIG.DRY_RUN) {
    throw new Error('assertDryRunMode: DRY_RUN is not true — refusing to start');
  }
  if (CONFIG.ALLOW_LIVE) {
    throw new Error('assertDryRunMode: ALLOW_LIVE=true in dry-run script — refusing to start');
  }
}
```
`DRY_RUN` evaluates as: `process.env.DRY_RUN !== 'false'` — so absent/any value = true (dry run).  
`ALLOW_LIVE` evaluates as: `process.env.ALLOW_LIVE === 'true'` — must be explicitly set.

**Question: Is this logic correct? Can any env var combination bypass it?**

### Gate 2: requireLiveAllowed() in liveExecutor.ts line 1
```typescript
export function requireLiveAllowed(): void {
  const result = checkExecutionAllowed();
  if (!result.allowed) {
    throw new Error(`LIVE_EXECUTION_DISABLED: ${result.reason}`);
  }
}
```
`checkExecutionAllowed()` requires ALL of:
1. `!CONFIG.DRY_RUN` — DRY_RUN must be explicitly `false`
2. `CONFIG.ALLOW_LIVE` — ALLOW_LIVE must be explicitly `true`
3. `CONFIG.CHAIN_ID === 8453`
4. `process.env.PRIVATE_KEY` is set
5. `CONFIG.CONTRACTS.APEX_FLASH_LOAN !== zero address`

**Question: Are all 5 checks correct? Any bypass path?**

### Gate 3: dryRunExecutor.ts
```typescript
export async function executeDryRun(opp: Opportunity): Promise<DryRunResult> {
  // No signing, no broadcasting, no wallet required
  logOpportunity(opp);
  alertOpportunity(opp.strategyId, opp.spreadBps, opp.blockNumber);
  return { logged: true, alerted: true, wouldExecute: opp.liveEligible };
}
```
**Question: Is there any code path that reaches `executeLive()` during a dry run?**

---

## Math to verify

### 1. cbETH fair-value edge calculation
```typescript
const fairWethPerCbEth = Number(exchangeRateRaw) / 1e18;
// exchangeRateRaw is returned by cbETH.exchangeRate() — a uint256 with 18 decimals
// e.g. 1.05e18 means 1 cbETH = 1.05 WETH

const dexWethPerCbEth = Number(dexWethOut) / Number(PROBE_WETH);
// PROBE_WETH = 3.33 ETH worth of cbETH (18 decimals)
// dexWethOut = quoted WETH output for 3.33 cbETH input

const grossEdgeBps = ((dexWethPerCbEth - fairWethPerCbEth) / fairWethPerCbEth) * 10_000;
// positive = DEX price ABOVE fair value = sell cbETH on DEX, buy at fair value
```
**Question: Is the direction correct? If dexPrice > fairValue, is selling cbETH on DEX actually profitable, or is the arb the other direction?**

### 2. Gas cost in bps (cbETH signal)
```typescript
const gasEth       = 0.0003;           // ~$0.90 at $3,000/ETH
const probeSizeEth = 3.33;             // probe in ETH
const gasAsBps     = (gasEth / probeSizeEth) * 10_000;  // = 0.9 bps
const totalCosts   = gasAsBps + 5 + (feeTierUsed / 100) + 10 + 5;
// = 0.9 + slippage(5) + dexFee(varies) + safety(10) + revert(5)
// = ~21–31 bps depending on fee tier
```
**Question: Is using probe size (3.33 ETH) as denominator appropriate for gas-in-bps calculation? The actual trade size may differ.**

### 3. DEX spread bps with bigint USDC
```typescript
const spreadBps = loanAmount > 0n
  ? Number(((bestSellOut - loanAmount) * 10_000n) / loanAmount)
  : 0;
// loanAmount in USDC (6 decimals, e.g. 10_000_000_000n for $10,000)
// bestSellOut in USDC (6 decimals)
// bigint division truncates — any precision loss?
```
**Question: For a 5 bps spread on $10,000 loan: profit = $5 = 5_000_000 units. (5_000_000 * 10_000) / 10_000_000_000 = 5. Correct?**

### 4. Net profit calculation (post-fix)
```typescript
// DEX spread:
netProfitUsd = Math.max(0, grossProfitUsd - 0.90 - grossProfitUsd * 0.0005)
// triangular arb:
netProfitUsd = Math.max(0, grossProfitUsd - 0.90 - grossProfitUsd * 0.0015)
// cbETH:
netProfitUsd = Math.max(0, grossProfitUsd - gasUsd - grossProfitUsd * 0.0005)
```
Gas $0.90 = 0.0003 ETH × $3,000. Slippage: 0.05% DEX / 0.15% triangular.  
**Question: Are these cost deductions realistic for Base L2?**

### 5. Triangular bps calc (bigint)
```typescript
const grossProfit = finalOut - amountIn;   // USDC units (6 decimals)
const spreadBps   = Number((grossProfit * 10_000n) / amountIn);
```
**Question: Same precision analysis as DEX spread. Does this truncate in any harmful way?**

### 6. Circuit breaker
```typescript
const drawdownPct = Number((initialBalance - current) * 10_000n / initialBalance) / 100;
if (drawdownPct >= CONFIG.DRAWDOWN_THRESHOLD) { /* halt */ }
// DRAWDOWN_THRESHOLD = 50 (50%)
```
**Question: Is this bigint arithmetic correct? Does dividing by 100 after the bigint division give the right percentage?**

---

## Bugs found and fixed (pre-dry-run)

| # | File | Bug | Fix applied |
|---|---|---|---|
| 1 | `cbETHFairValueSignal.ts` | `grossProfitUsd: 0` hardcoded — report would show $0 for cbETH strategy | Computed from `grossEdgeBps * probeSizeEth * ethPriceUsd` |
| 2 | `dexSpreadSignal.ts` | `netProfitUsd: 0` hardcoded — backtester net P&L always $0 | Computed as `grossUsd - gasUsd - slippageUsd` |
| 3 | `triangularArbSignal.ts` | `netProfitUsd: 0` hardcoded — same issue | Computed as `grossUsd - gasUsd - slippageUsd` |
| 4 | `liveExecutor.ts` | Used `plan.opportunity.tokenIn` as contract address instead of flash loan contract | Changed to `CONFIG.CONTRACTS.APEX_FLASH_LOAN` |
| 5 | `cbETHFairValueSignal.ts` | Unused `import { createHash }` | Removed |

---

## Threshold inconsistency — please evaluate

| Strategy | Gate | Metric |
|---|---|---|
| `grok.cbeth_fair_value` | `MIN_NET_EDGE_BPS = 5` | Net (after costs deducted) |
| `apex.dex_spread` | `MIN_PROFIT_BPS = 20` | Gross (before cost deduction) |
| `apex.triangular` | `MIN_PROFIT_BPS = 20` | Gross (before cost deduction) |

cbETH filters at 5 bps NET. DEX/triangular filter at 20 bps GROSS.  
With ~20 bps total costs on a typical DEX trade, the effective net threshold for DEX/triangular is ~0 bps.  
**This means DEX and triangular may log marginal trades that show negative net P&L in the report.**

**Question: Should all three strategies use the same net threshold? Recommend value?**

---

## Items NOT in scope (not needed for dry run)

- `ApexFlashLoan.sol` — contract not deployed yet, not needed for dry run
- `liveExecutor.ts` — unreachable in dry run (requireLiveAllowed throws)
- `bundlePlanner.ts` / `flashLoanPlanner.ts` — not called in dry run path
- Builder submission (ENABLE_BUILDER_SUBMISSION=false by default)

---

## Key questions for review

1. **Safety gates:** Can live execution be reached without explicit ALLOW_LIVE=true?
2. **cbETH direction:** Is buy-low-on-DEX / sell-high correct, or vice versa?
3. **Gas estimate:** Is 0.0003 ETH (~$0.90) conservative enough for Base L2 in 2026?
4. **MIN_PROFIT_BPS = 20 gross:** Is this too low for DEX spread given total costs of ~20–25 bps?
5. **Threshold unification:** Should we align all three strategies on the same net threshold?
6. **Triangular slippage:** Is 0.15% (15 bps) enough for 3-hop slippage on Base?
7. **Ternary search:** The loan sizing optimization is in `flashLoanPlanner.ts` — is 8 iterations enough convergence for $1K–$50K range?

---

## What the 72-hour dry run will produce

After 72 hours running against Base mainnet (read-only, no txs), the system generates:
- JSONL logs: one line per opportunity detected
- `generate-report.ts` reads logs and outputs:
  - Per-strategy: scan count, accepted/rejected, gross P&L, net P&L, median bps, false-positive rate
  - `liveReadinessScore` 0–100
  - Blockers list

**Live execution gated on:** score ≥ 70 + positive net P&L confirmed + all credentials rotated.
