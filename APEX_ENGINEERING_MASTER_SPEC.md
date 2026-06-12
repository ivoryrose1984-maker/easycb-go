# APEX-UNIFIED — ENGINEERING MASTER SPEC v1.0
**For:** Claude Code, repo ivoryrose1984-maker/easycb-go, branch claude/new-session-ao4nr
**From:** Strategy session 2026-06-11 · **Owner:** Shawn Lutz, NeXxt Gen Innovations LLC
**Standing rule:** Verify every external address, ABI, and endpoint against official docs before use. Do not trust addresses in this spec without verification — they are pointers, not gospel. All work compiles clean, ships tests, and never prints secrets.

---

# PART I — ARCHITECTURE DOCTRINE (governs every work order)

**D1. The hot path is sacred.** Block-event → decision → submission must never be blocked by logging, Telegram, Supabase, or any I/O. All telemetry is fire-and-forget with in-memory buffering. Any WO that adds >5ms p99 to the hot path is rejected.

**D2. One source of truth for profit math.** The function that computes expected net profit (gross − gas − flash premium − priority fee − latency buffer) is ONE shared module used by dry-run simulation, live execution, and telemetry. Divergent estimate paths created the phantom-profit disaster; never again.

**D3. Every opportunity is accounted for.** Detected → (skipped with reason | submitted → resolved). No silent drops. The `.catch(() => 0n)` pattern that hid the Aerodrome ABI bug for 12,538 scans is banned; every catch logs reason and context.

**D4. Config over code.** Every threshold (impact bps, min edge, tip %, HF trigger) is env-configurable with documented defaults chosen to be SAFE not permissive. The LIQUIDITY_MAX_IMPACT_BPS=5000 default that neutered the filter is the anti-pattern.

**D5. Strategies are plugins.** Each strategy implements one interface: `scan(blockCtx) → Opportunity[]`, `build(opp) → SignedTxRequest`. Adding a strategy never touches the engine.

**D6. Kill switches everywhere.** Per-strategy enable flags, global circuit breaker (existing 50% drawdown), plus new: max consecutive losses per strategy (default 5 → auto-disable + Telegram alert), max daily gas spend (default $10 → halt).

---

# PART II — BASE EXECUTION MECHANICS (read before WO-3)

Base is an OP-Stack L2: **no public mempool**, centralized sequencer, ~2s blocks, transaction ordering by priority fee then arrival. Consequences:

1. **You cannot see competitors' pending txs and they cannot see yours.** Frontrunning defense is free; backrunning REQUIRES reacting to confirmed state, not pending txs. The mempool-listener heritage of this codebase is mainnet thinking — on Base, the unit of reaction is the new block (or flashblock).
2. **Flashblocks:** Base emits ~200ms preconfirmation sub-blocks via a dedicated websocket stream. Subscribing to flashblocks instead of full blocks cuts reaction latency from ~2s to ~200ms — the single biggest latency win available without moving servers. WO-3 task. Verify current endpoint and payload format in Base docs (base.org/docs, search "flashblocks websocket").
3. **Inclusion is bought with priority fee.** No bundles, no builders on the happy path. Dynamic tipping (WO-3.4) is the auction strategy.
4. **Latency hierarchy:** flashblock subscription > premium RPC websocket > polling. Server location matters only after software latency is optimized — measure first (WO-4).

---

# PART III — WORK ORDERS

## WO-1 — CAPTURE TELEMETRY *(blocks live launch — already issued, included for completeness)*

Module src/core/captureTelemetry.ts, one JSONL stream logs/capture-YYYY-MM-DD.jsonl, three lifecycle events sharing opportunityId:
- **detected** (dry-run + live): strategyId, block, ts_ms, path, spread_bps, expected_gross_usd, expected_net_usd (via D2 shared math), loan_size, pools, filter_result, skipReason if skipped.
- **submitted** (live): tx_hash, ts_ms, detect_to_submit_ms, gas_price, priority_fee, nonce.
- **resolved** (live): outcome ∈ {LANDED_PROFIT, LANDED_LOSS, REVERTED, NOT_INCLUDED, ERROR}, inclusion_block, blocks_elapsed, actual_gross_usd, actual_net_usd, expected_vs_actual_delta. NOT_INCLUDED = nonce unconsumed after 5 blocks.

Report extension (npm run report): per-strategy detected / submission rate / inclusion rate / win rate / **capture rate** (landed-profitable ÷ detected) / avg profit delta / avg detect-to-inclusion blocks.
**Accept:** 1h dry run produces rows with skipReasons for all four strategies; hot-path timing proof <5ms p99 added; tests cover NOT_INCLUDED resolution.

## WO-2 — POOL DISCOVERY + LIQUIDITY-AWARE SIZING

**2.1 Discovery indexer** (src/core/poolRegistry.ts): query factory PoolCreated/PairCreated logs (Uniswap V3 factory, PancakeSwap V3 factory, Aerodrome factory — verify Base addresses from each protocol's docs) over chunked eth_getLogs from a configurable start block. Persist registry to disk (pools.json) with: pool address, tokens, fee tier/stable flag, last-known TVL estimate, enabled flag. Daily refresh job. Filter: only pools where both tokens are in a configurable allowlist of ~30 quality Base tokens (avoid honeypots — never auto-trade unknown tokens) AND estimated TVL ≥ POOL_MIN_TVL_USD (default 50000).
**2.2 Scan integration:** dexSpreadSignal iterates registry pools, not hardcoded pairs. Batch all quotes via Multicall3 (existing pattern). Target capacity: 500 pools/block-cycle within RPC budget — implement quote batching with a per-cycle compute budget and round-robin rotation if over budget (hot pools every cycle, cold pools every Nth).
**2.3 Liquidity-aware sizing:** replace fixed probe with 3-point quote ladder (e.g. $500 / $5K / $25K notional) per candidate; compute realized price impact curve; choose largest size where impact ≤ LIQUIDITY_MAX_IMPACT_BPS (100) AND expected net ≥ MIN_NET_EDGE. Small uncontested fills beat zero contested fills.
**Accept:** registry builds with count logged; scan covers ≥200 pools; a known thin pool gets sized down not rejected when a small size clears the filter; DAI/WETH phantom still produces zero opportunities; RPC compute units per cycle measured and logged.

## WO-3 — BASE-NATIVE HOT PATH

**3.1 Flashblock subscription:** add a second WSS subscription to Base flashblocks (verify endpoint per Part II). Feed scans from flashblock state where possible; fall back to full-block subscription automatically if the stream dies (ResilientWs pattern reused).
**3.2 Hot-path restructure:** on block/flashblock event → state diff check (only re-quote pools whose tokens appeared in event logs, full re-scan every Nth block) → evaluate → build → sign → send. Everything pre-computable (router calldata templates, gas estimates per route shape, nonce) is computed cold. Target: detect-to-submit p50 < 150ms, measured by WO-1 telemetry.
**3.3 Warm signer:** persistent nonce manager + pre-built typed-tx skeletons per route shape; signing fills amounts only. No per-opportunity ABI encoding from scratch.
**3.4 Dynamic priority fee:** tip = clamp(TIP_PCT_OF_PROFIT × expected_net, TIP_MIN_GWEI, TIP_MAX_USD). Defaults: 25% / 0.001 gwei floor / $2 cap. Auto-tune hook: if telemetry shows NOT_INCLUDED > 30% over trailing 100 submissions, raise TIP_PCT by 5 points up to 50%; log every adjustment.
**Accept:** latency histogram in report (detect→submit, submit→inclusion); flashblock feed survives forced disconnect; tip adjustments visible in logs; full-block fallback proven by killing the flashblock socket mid-run.

## WO-4 — LATENCY INSTRUMENTATION (small, do alongside WO-3)

Measure and report: (a) block timestamp vs local receipt time per provider; (b) submit→inclusion blocks distribution; (c) RPC method round-trip p50/p99. Output a weekly latency section in npm run report. Decision rule documented in README: spend money on RPC tier or server move ONLY if (a) shows provider lag > 300ms or (b) shows systematic 2+ block inclusion delay at max tip.

## WO-5 — LIQUIDATION STRATEGY (Moonwell + Aave V3 Base) — *most likely first reliable income*

**5.1 Position indexer:** track borrowers via Borrow/Supply/Repay/Withdraw events on Aave V3 Pool (Base) and Moonwell mToken markets (Compound-v2-style). Maintain in-memory map of accounts with debt > LIQ_MIN_DEBT_USD (default 500), refreshed by events + periodic sweep. Health factor: Aave getUserAccountData(); Moonwell comptroller getAccountLiquidity().
**5.2 Trigger engine:** each block, re-price the watchlist using Chainlink feeds (same oracle module as cbETH); accounts within HF_WATCH_BAND (1.00–1.05) get per-block checks; HF < 1.0 → build liquidation.
**5.3 Execution:** flash loan debt asset (existing Balancer V2 0% module) → liquidationCall (Aave: close factor 50%, or 100% below HF 0.95 — verify current params) / liquidateBorrow (Moonwell) → receive collateral + bonus (Aave per-asset ~5–10%, Moonwell ~8% — verify per market) → swap collateral to debt asset via best venue from WO-2 registry → repay → profit check → atomic revert if net ≤ 0. Same DRY_RUN gate: simulate and log, don't send.
**5.4 Telemetry:** full WO-1 lifecycle; strategyId apex.liquidation_aave / apex.liquidation_moonwell.
**Accept:** dry-run logs show watchlist size, near-liquidation accounts, and simulated liquidations with expected bonus; one historical liquidation replayed end-to-end in a fork test (hardhat fork of Base) proving the atomic path; all protocol addresses verified against official docs in code comments with source URLs.

## WO-6 — DUAL-ANCHOR LST FAIR-VALUE (upgrade of grok.cbeth_fair_value)

Two anchors per LST: **accrual anchor** = Chainlink exchange-rate feed (cbETH/ETH exchange rate, Base); **market anchor** = Chainlink market price feed. Trade only when DEX price deviates from accrual anchor by > LST_MIN_DEVIATION_BPS (default 30) AND in the direction of reversion AND market anchor confirms (deviation not explained by market-wide repricing). Extend to wstETH and weETH on Base (verify both have Chainlink Base feeds; skip any LST without one). Stale-feed guard: reject if updatedAt older than heartbeat. Sanity band per LST configurable.
**Accept:** strategy skips when feeds stale; per-LST scan counts in SCAN line; fork test replaying a historical deviation.

## WO-7 — NEW-POOL LAUNCH WATCHER

Subscribe live to factory PoolCreated events (registry from WO-2 reused). New pool in allowlisted-token pair → priority scan every block for first NEW_POOL_WATCH_HOURS (default 24) with tighter sizing (max $1K notional) and a higher edge requirement (2× MIN_NET_EDGE) to compensate for unknown depth behavior. Telegram alert on every new allowlisted pool.
**Accept:** synthetic test injecting a PoolCreated log produces a watch entry and priority scans; expiry works.

## WO-8 — WEEKLY STRATEGY REVIEW GENERATOR

npm run review: reads WO-1 telemetry for trailing 7 and 28 days → per-strategy table (detected, capture rate, net P&L after gas, trend vs prior week) → applies kill/scale rules from doctrine D6 → outputs recommendation block (KEEP / KILL / SCALE per strategy) → posts summary to Telegram. Decisions stay human; the report makes them obvious.
**Accept:** runs against existing dry-run logs today and produces the table with capture-rate columns showing n/a for unfilled live fields.

---

# PART IV — SEQUENCE & GATES

1. WO-1 → **gate: live launch permitted** (after existing gates: 48h clean dry-run, contract deployed, keys rotated, fresh wallet)
2. Live week 1 on dex_spread + LST with small wallet → capture-rate ground truth
3. WO-2 + WO-4 in parallel with live week 1
4. WO-3 once WO-4 telemetry identifies the binding latency constraint
5. WO-5 (liquidations) — highest income conviction, start fork-testing during live week 1
6. WO-6, WO-7, WO-8 as capacity allows
7. **Capital rule:** wallet grows only from its own profits until infra costs recovered. **Multi-chain rule:** Solana port only after Base is 4-week net-positive.

# PART V — STANDING PROHIBITIONS
- No secrets in chat, logs, commits, or Claude Code output — key names only
- No profit claims in any external material without live telemetry behind them
- No new strategy goes live without 1 week of dry-run telemetry + fork test
- No silent catches; no divergent profit-math paths; no hardcoded pairs after WO-2

---

# PART VI — ETHICAL CEILING (non-negotiable, audited in every code review)

**Approved mechanics:** back-run/atomic arbitrage, cross-DEX routing, protocol liquidations, LST fair-value reversion. These tighten spreads, support lending solvency, and harm no individual user.

**Prohibited permanently:** sandwiching, front-running, or any strategy whose profit derives from degrading a specific user's execution. Technically irrelevant on Base (no public mempool) and ethically incompatible with this project's mission regardless of chain. Any future code path resembling these is rejected at review.
