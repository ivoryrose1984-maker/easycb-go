import CONFIG from '../core/config';
import { GasForecast } from './gasForecaster';
import { gweiToWei } from '../core/config';
import { Opportunity } from '../types/Opportunity';
import { ExecutionPlan } from '../types/ExecutionPlan';
import { encode2HopPath } from './routePlanner';

// ── Babylonian integer square root ────────────────────────────────────────────
// Returns floor(√n). No heap allocation — operates entirely on BigInt value
// types. Converges in O(log log n) iterations from a bit-length initial guess.
export function bigintSqrt(n: bigint): bigint {
  if (n <= 0n) return 0n;
  // 2^ceil(bits/2) ≥ √n always — at most 2 extra Babylonian iters needed.
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  while (true) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;   // x = floor(√n) — converged
    x = y;
  }
}

// ── Closed-form optimal flash loan input for 2-pool CFMM ──────────────────────
// VOLATILE (x·y=k) POOLS ONLY — NOT Aerodrome stable pools (x³y+xy³=k) or any
// concentrated-liquidity pool. For stable Aerodrome pairs use getAmountOutStable.
//
// Solves dP/dΔx = 0 for a constant-product (x·y = k) 2-pool arbitrage path.
//
// Derivation: profit P(u) = K·u / (A + B·u) − u where
//   K = g_a·g_b·xB·yA,  A = xA·yB,  B = g_a·(yB + g_b·yA)
//   g = (10000 − feeBps) / 10000  (effective fee multiplier in bps units)
//
// Setting dP/du = 0: (A + B·u)² = K·A
//   → u* = 10000·(√(γ_a·γ_b·xA·yA·xB·yB) − xA·yB·10000)
//           / (γ_a·(10000·yB + γ_b·yA))
//
// Pool orientation:
//   rA.x = tokenIn  reserves in pool A (buy leg)   rA.y = tokenOut
//   rB.x = tokenOut reserves in pool B (sell leg)  rB.y = tokenIn
//   i.e. rB is the mirror: what A gave us goes in, what we started with comes out.
//
// Returns null when: pools at equilibrium (no arb), negative numerator, or
// degenerate reserves (zero).
export interface PoolReserves { x: bigint; y: bigint }

export function optimalInputCFMM(
  rA: PoolReserves,
  rB: PoolReserves,
  feeBpsA: bigint,
  feeBpsB: bigint,
): bigint | null {
  if (rA.x === 0n || rA.y === 0n || rB.x === 0n || rB.y === 0n) return null;
  if (feeBpsA >= 10_000n || feeBpsB >= 10_000n) return null;

  const gammaA = 10_000n - feeBpsA;
  const gammaB = 10_000n - feeBpsB;

  // √(γ_a·γ_b·xA·yA·xB·yB) — product can reach ~10^104 for 30-ETH positions
  const sqrtProd = bigintSqrt(gammaA * gammaB * rA.x * rA.y * rB.x * rB.y);

  // num = √(...) − xA·yB·10000
  const num = sqrtProd - rA.x * rB.y * 10_000n;
  if (num <= 0n) return null;

  const denom = gammaA * (10_000n * rB.y + gammaB * rA.y);
  if (denom === 0n) return null;

  const optimal = num * 10_000n / denom;
  return optimal > 0n ? optimal : null;
}

// ── Analytical max gross edge at u* (no RPC) ─────────────────────────────────
// Pre-screens a pair before any RPC call: if this returns < MIN_NET_EDGE_BPS +
// cost_bps, skip. Returns null when no profitable arb exists at these reserves.
export function maxGrossEdgeBps(
  rA: PoolReserves,
  rB: PoolReserves,
  feeBpsA: bigint,
  feeBpsB: bigint,
): number | null {
  const u = optimalInputCFMM(rA, rB, feeBpsA, feeBpsB);
  if (!u || u <= 0n) return null;

  const gammaA = 10_000n - feeBpsA;
  const gammaB = 10_000n - feeBpsB;

  const dy    = gammaA * rA.y * u / (rA.x * 10_000n + gammaA * u);
  const dxOut = gammaB * rB.x * dy / (rB.y * 10_000n + gammaB * dy);

  if (dxOut <= u) return null;
  return Number((dxOut - u) * 10_000n / u);
}

// ── Dynamic break-even edge threshold ────────────────────────────────────────
// Returns the minimum gross spread (bps) needed to net > 0 after gas + buffers.
// Replaces the static MIN_NET_EDGE_BPS when you have real-time gas + loan size.
// loanAmountInUsd6: loan size in 6-dec USD units (same as USDC base units).
export function breakEvenEdgeBps(
  gasForecast: GasForecast,
  ethPriceUsd6: bigint,   // ETH price in 6-dec USDC
  loanAmountUsd6: bigint, // loan in 6-dec USDC
): number {
  if (loanAmountUsd6 === 0n) return 9_999;
  // Include both base fee AND priority fee — omitting priority understated threshold by ~1.5 bps
  const gasCostWei  = CONFIG.GAS_ESTIMATE * (gasForecast.predictedBaseFee + gasForecast.predictedPriority);
  const gasCostUsd6 = (gasCostWei * ethPriceUsd6) / 10n ** 18n;
  const gasBps      = Number(gasCostUsd6 * 10_000n / loanAmountUsd6);
  return gasBps + CONFIG.LATENCY_BUFFER_BPS + CONFIG.FAILURE_BUFFER_BPS;
}

export interface ProfitResult {
  netProfit:           bigint;
  score:               number;
  shouldExecute:       boolean;
  gasCostWei:          bigint;
  maxFeePerGas:        bigint;
  priorityFeePerGas:   bigint;
  slippageEstimateBps: number;
}

export function calculateNetProfit(
  amountIn:    bigint,
  sellQuote:   bigint,
  gasForecast: GasForecast,
  ethPriceUsd: bigint,
  isWethInput  = false,
): ProfitResult {
  const grossProfit = sellQuote - amountIn;
  const gasCostWei  = CONFIG.GAS_ESTIMATE *
    (gasForecast.predictedBaseFee + gasForecast.predictedPriority);
  // Match gas cost denomination to amountIn: WEI for WETH inputs, 6-dec USDC otherwise
  const gasCostInInputUnits = isWethInput
    ? gasCostWei
    : (gasCostWei * ethPriceUsd) / 10n ** 18n;

  const priorityPct     = BigInt(gasForecast.dynamicPriorityPct);
  const priorityBudget  = grossProfit > 0n ? (grossProfit * priorityPct) / 100n : 0n;

  const latencyCost  = amountIn > 0n ? (amountIn * BigInt(CONFIG.LATENCY_BUFFER_BPS))  / 10_000n : 0n;
  const failureCost  = amountIn > 0n ? (amountIn * BigInt(CONFIG.FAILURE_BUFFER_BPS))  / 10_000n : 0n;

  const netProfit = grossProfit - gasCostInInputUnits - priorityBudget - latencyCost - failureCost;
  const score     = amountIn > 0n ? Number((netProfit * 10_000n) / amountIn) : 0;

  const shouldExecute = netProfit > 0n && score >= CONFIG.MIN_PROFIT_BPS && grossProfit > gasCostInInputUnits;

  const priorityWei    = ethPriceUsd > 0n ? (priorityBudget * 10n ** 18n) / ethPriceUsd : gweiToWei(CONFIG.MIN_PRIORITY_FEE_GWEI);
  const priorityPerGas = CONFIG.GAS_ESTIMATE > 0n ? priorityWei / CONFIG.GAS_ESTIMATE : 0n;
  const minPriority    = CONFIG.MIN_PRIORITY_FEE_GWEI * 1_000_000_000n;
  const priorityFeePerGas = priorityPerGas > minPriority ? priorityPerGas : minPriority;
  const maxFeePerGas      = gasForecast.predictedBaseFee * CONFIG.BASE_FEE_MULTIPLIER + priorityFeePerGas;

  const slippageEstimateBps = Math.min(250, Math.round(Math.sqrt(Number(amountIn) / 1e12) * 10));

  return { netProfit, score, shouldExecute, gasCostWei, maxFeePerGas, priorityFeePerGas, slippageEstimateBps };
}

export function buildExecutionPlan(
  opp:           Opportunity,
  routerAddress: string,
  feeBuy:        number,
  feeSell:       number,
  sellQuote:     bigint,
  gasForecast:   GasForecast,
  ethPriceUsd:   bigint,
): ExecutionPlan {
  const loanAmount   = BigInt(opp.quotedInput);
  const minAmountOut = sellQuote * 995n / 1000n;  // 0.5% slippage protection
  const isWethInput  = opp.tokenIn.toLowerCase() === CONFIG.TOKENS.WETH.toLowerCase();

  const route = encode2HopPath(
    opp.tokenIn,  feeBuy,
    opp.tokenOut, feeSell,
    opp.tokenIn,  // round-trip: repay same token as loan
  );

  const profit = calculateNetProfit(loanAmount, sellQuote, gasForecast, ethPriceUsd, isWethInput);
  const maxFeePerGas = gasForecast.predictedBaseFee * CONFIG.BASE_FEE_MULTIPLIER + profit.priorityFeePerGas;

  const estimatedProfitUsd = profit.netProfit > 0n
    ? isWethInput
      ? Number(profit.netProfit) / 1e18 * (Number(ethPriceUsd) / 1e6)
      : Number(profit.netProfit) / 1e6
    : 0;

  return {
    opportunity:          opp,
    loanToken:            opp.tokenIn,
    loanAmount:           loanAmount.toString(),
    routerAddress,
    route,
    minAmountOut:         minAmountOut.toString(),
    gasLimit:             CONFIG.TX_GAS_LIMIT.toString(),
    maxFeePerGas:         maxFeePerGas.toString(),
    maxPriorityFeePerGas: profit.priorityFeePerGas.toString(),
    targetBlock:          opp.blockNumber + 1,
    builderUrls:          CONFIG.BUILDERS.filter(b => b.enabled).map(b => b.url),
    estimatedProfitUsd,
    ethPriceUsd6:         ethPriceUsd.toString(),
  };
}

// 8-iteration ternary search maximising a bigint objective over [lo, hi].
// Returns the midpoint of the final bracket — converges to within 1/3^8 ≈ 0.015% of range.
export async function ternarySearchSize(
  fn:    (size: bigint) => Promise<bigint>,
  lo:    bigint,
  hi:    bigint,
  iters: number = CONFIG.MAX_TERNARY_ITERS,
): Promise<bigint> {
  let left = lo, right = hi;
  for (let i = 0; i < iters; i++) {
    const m1 = left + (right - left) / 3n;
    const m2 = right - (right - left) / 3n;
    const [v1, v2] = await Promise.all([fn(m1), fn(m2)]);
    if (v1 > v2) right = m2;
    else          left  = m1;
  }
  return (left + right) / 2n;
}

export async function findOptimalLoanSize(
  fn:    (amount: bigint) => Promise<ProfitResult>,
  min  = CONFIG.MIN_LOAN_USDC,
  max  = CONFIG.MAX_LOAN_USDC,
  iters = CONFIG.MAX_TERNARY_ITERS
): Promise<{ optimalAmount: bigint; maxProfit: ProfitResult }> {
  let left = min, right = max;
  for (let i = 0; i < iters; i++) {
    const m1 = left + (right - left) / 3n;
    const m2 = right - (right - left) / 3n;
    const [r1, r2] = await Promise.all([fn(m1), fn(m2)]);
    if (r1.netProfit > r2.netProfit) right = m2;
    else                              left  = m1;
  }
  const optimalAmount = (left + right) / 2n;
  return { optimalAmount, maxProfit: await fn(optimalAmount) };
}
