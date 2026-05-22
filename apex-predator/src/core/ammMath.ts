/**
 * ammMath.ts — Production AMM math for exact trade simulation.
 *
 * All core price/amount functions use bigint exclusively (no floating point).
 * Floating point is used only in display/helper functions (virtual reserves,
 * confidence scores) where integer precision is not critical.
 *
 * Covers:
 *  - Uniswap V2 (xy = k)
 *  - Uniswap V3 (concentrated liquidity, virtual-reserve single-tick approximation)
 *  - Multi-hop cycle simulation
 *  - Safety / profitability helpers
 */

// ─── V3 constants ─────────────────────────────────────────────────────────────

/** Q96 fixed-point multiplier used in Uniswap V3 sqrtPriceX96 encoding. */
export const Q96 = 2n ** 96n;

/** Minimum valid sqrtPriceX96 (corresponds to price ≈ 2^-128). */
export const MIN_SQRT_RATIO = 4295128739n;

/** Maximum valid sqrtPriceX96 (corresponds to price ≈ 2^128). */
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

// ─── Uniswap V2 ───────────────────────────────────────────────────────────────

/**
 * Compute the exact output for a given exact input on a Uniswap V2 pool.
 *
 * Formula matches the Uniswap V2 Router exactly:
 *   amountInWithFee = amountIn × (10000 − feeBps)
 *   numerator       = amountInWithFee × reserveOut
 *   denominator     = reserveIn × 10000 + amountInWithFee
 *   amountOut       = numerator / denominator   (integer floor division)
 *
 * Returns 0n when amountIn is 0 or either reserve is 0.
 */
export function v2GetAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number, // e.g. 30 for 0.3%, 25 for 0.25%
): bigint {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) return 0n;
  const amountInWithFee = amountIn * BigInt(10000 - feeBps);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 10000n + amountInWithFee;
  return numerator / denominator;
}

/**
 * Compute the minimum exact input required to obtain a given exact output on a
 * Uniswap V2 pool.
 *
 * Uses ceiling division so that the returned amountIn is always sufficient to
 * produce at least amountOut after integer truncation by the pool contract.
 *
 * Returns 0n when amountOut is 0. Throws if amountOut ≥ reserveOut (impossible
 * trade — the pool cannot provide that much output).
 */
export function v2GetAmountIn(
  amountOut: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number,
): bigint {
  if (amountOut === 0n) return 0n;
  if (reserveIn === 0n || reserveOut === 0n || amountOut >= reserveOut) {
    throw new RangeError(
      `v2GetAmountIn: amountOut (${amountOut}) must be < reserveOut (${reserveOut}) and reserves must be non-zero`,
    );
  }
  // Derivation from v2GetAmountOut:
  //   amountOut = (amountIn × (10000 − feeBps) × reserveOut)
  //               / (reserveIn × 10000 + amountIn × (10000 − feeBps))
  // Solving for amountIn and applying ceiling division:
  const numerator = reserveIn * amountOut * 10000n;
  const denominator = (reserveOut - amountOut) * BigInt(10000 - feeBps);
  // Ceiling division: (a + b − 1) / b
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Price impact of a trade in basis points, measured as the difference between
 * the mid-price (spot price at zero size) and the execution price, expressed
 * as a fraction of the mid-price.
 *
 *   impact = amountIn / (reserveIn + amountIn) × 10000
 *
 * This is the standard fee-independent AMM depth formula. Returns a number
 * (not bigint) because sub-basis-point precision is meaningful here.
 *
 * Returns 0 when amountIn is 0 or reserveIn is 0.
 */
export function v2PriceImpactBps(
  amountIn: bigint,
  reserveIn: bigint,
  // reserveOut is unused in the depth formula but kept for API symmetry
  _reserveOut: bigint,
): number {
  if (amountIn === 0n || reserveIn === 0n) return 0;
  return Number(amountIn * 10000n) / Number(reserveIn + amountIn);
}

// ─── Uniswap V3 ───────────────────────────────────────────────────────────────

/**
 * Integer square-root helper (Newton's method, bigint).
 * Returns floor(sqrt(n)).
 */
function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('isqrt: negative input');
  if (n === 0n) return 0n;
  // Seed from floating-point, then refine with Newton
  let x = BigInt(Math.ceil(Math.sqrt(Number(n))));
  while (true) {
    const x1 = (x + n / x) / 2n;
    if (x1 >= x) return x;
    x = x1;
  }
}

/**
 * Encode a price ratio as a Q64.96 sqrtPriceX96 value, matching
 * Uniswap V3's TickMath / SqrtPriceMath encoding.
 *
 *   sqrtPriceX96 = floor(sqrt(amount1 / amount0) × 2^96)
 *
 * The calculation is done in integer arithmetic to avoid float overflow:
 *   sqrtPriceX96 = isqrt(amount1 × Q96² / amount0)
 */
export function encodeSqrtRatioX96(amount0: bigint, amount1: bigint): bigint {
  if (amount0 === 0n) throw new RangeError('encodeSqrtRatioX96: amount0 must be non-zero');
  return isqrt((amount1 * Q96 * Q96) / amount0);
}

/**
 * Derive the virtual token0 and token1 reserves implied by a V3 pool's
 * current sqrtPriceX96 and active liquidity.
 *
 *   reserve0 = liquidity × Q96 / sqrtPriceX96       (integer division)
 *   reserve1 = liquidity × sqrtPriceX96 / Q96        (integer division)
 *
 * These are the "virtual reserves" that make the concentrated liquidity pool
 * behave like a V2 pool within the current price range. Both values are
 * returned as bigints.
 */
export function v3VirtualReserves(
  sqrtPriceX96: bigint,
  liquidity: bigint,
): { reserve0: bigint; reserve1: bigint } {
  if (sqrtPriceX96 === 0n) throw new RangeError('v3VirtualReserves: sqrtPriceX96 must be non-zero');
  const reserve0 = (liquidity * Q96) / sqrtPriceX96;
  const reserve1 = (liquidity * sqrtPriceX96) / Q96;
  return { reserve0, reserve1 };
}

/**
 * Normalize a Uniswap V3 fee tier to basis points for use in V2-style formulas.
 *
 *   feeTier / 100 → bps
 *
 * Standard tiers: 100 → 1 bps, 500 → 5 bps, 3000 → 30 bps, 10000 → 100 bps.
 */
export function feeTierToBps(feeTier: number): number {
  return Math.floor(feeTier / 100);
}

/**
 * Estimate the output amount for a single-hop Uniswap V3 swap using the
 * virtual-reserve approximation (single-tick, constant-liquidity assumption).
 *
 * This is accurate for trades that stay within the current active tick's
 * liquidity range. For cross-tick trades it provides a lower bound on the
 * actual output (real output is slightly higher when additional ticks activate).
 *
 * Strategy:
 *  1. Derive virtual reserves from sqrtPriceX96 and liquidity.
 *  2. Apply the V2 constant-product formula with the V3 fee (in bps).
 *     - zeroForOne=true  → token0 in, token1 out → reserveIn=reserve0, reserveOut=reserve1
 *     - zeroForOne=false → token1 in, token0 out → reserveIn=reserve1, reserveOut=reserve0
 */
export function v3GetAmountOut(
  amountIn: bigint,
  sqrtPriceX96: bigint,
  liquidity: bigint,
  zeroForOne: boolean,
  feeTier: number, // 100, 500, 3000, or 10000
): bigint {
  const { reserve0, reserve1 } = v3VirtualReserves(sqrtPriceX96, liquidity);
  const feeBps = feeTierToBps(feeTier);
  if (zeroForOne) {
    // token0 in → token1 out
    return v2GetAmountOut(amountIn, reserve0, reserve1, feeBps);
  } else {
    // token1 in → token0 out
    return v2GetAmountOut(amountIn, reserve1, reserve0, feeBps);
  }
}

/**
 * Price impact (slippage) in basis points for a V3 trade.
 *
 * Computed via virtual reserves + the V2 depth formula, so it represents
 * the fraction of amountIn relative to the virtual reserve depth.
 */
export function v3SlippageBps(
  amountIn: bigint,
  sqrtPriceX96: bigint,
  liquidity: bigint,
  zeroForOne: boolean,
  _feeTier: number,
): number {
  const { reserve0, reserve1 } = v3VirtualReserves(sqrtPriceX96, liquidity);
  const reserveIn = zeroForOne ? reserve0 : reserve1;
  return v2PriceImpactBps(amountIn, reserveIn, 0n);
}

// ─── Multi-hop cycle simulation ───────────────────────────────────────────────

/** Parameters for a single hop in a multi-hop arbitrage cycle. */
export interface HopParams {
  protocol: 'v2' | 'v3';
  amountIn: bigint;
  // V2 fields
  reserveIn?: bigint;
  reserveOut?: bigint;
  feeBps?: number;
  // V3 fields
  sqrtPriceX96?: bigint;
  liquidity?: bigint;
  zeroForOne?: boolean;
  feeTier?: number;
}

/**
 * Simulate a complete multi-hop arbitrage cycle and return the final output
 * amount.
 *
 * Each hop's amountIn is overridden with the previous hop's output, so only
 * the first hop's amountIn matters as the initial capital. The caller should
 * set amountIn on each hop for documentation purposes, but the function re-
 * chains outputs automatically.
 *
 * Returns 0n if any hop in the chain produces 0 output.
 *
 * Throws on invalid hop parameters (missing required fields for the protocol).
 */
export function simulateCycleExact(hops: HopParams[]): bigint {
  if (hops.length === 0) return 0n;

  let amount = hops[0].amountIn;

  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    // For hops after the first, chain the previous output
    const hopIn = i === 0 ? hop.amountIn : amount;

    if (hop.protocol === 'v2') {
      const reserveIn = hop.reserveIn;
      const reserveOut = hop.reserveOut;
      const feeBps = hop.feeBps;
      if (reserveIn === undefined || reserveOut === undefined || feeBps === undefined) {
        throw new TypeError(
          `simulateCycleExact: hop ${i} (v2) requires reserveIn, reserveOut, and feeBps`,
        );
      }
      amount = v2GetAmountOut(hopIn, reserveIn, reserveOut, feeBps);
    } else if (hop.protocol === 'v3') {
      const sqrtPriceX96 = hop.sqrtPriceX96;
      const liquidity = hop.liquidity;
      const zeroForOne = hop.zeroForOne;
      const feeTier = hop.feeTier;
      if (
        sqrtPriceX96 === undefined ||
        liquidity === undefined ||
        zeroForOne === undefined ||
        feeTier === undefined
      ) {
        throw new TypeError(
          `simulateCycleExact: hop ${i} (v3) requires sqrtPriceX96, liquidity, zeroForOne, and feeTier`,
        );
      }
      amount = v3GetAmountOut(hopIn, sqrtPriceX96, liquidity, zeroForOne, feeTier);
    } else {
      throw new TypeError(`simulateCycleExact: unknown protocol at hop ${i}: ${(hop as HopParams).protocol}`);
    }

    if (amount === 0n) return 0n;
  }

  return amount;
}

// ─── Safety / profitability helpers ───────────────────────────────────────────

/**
 * Compute a 0–100 confidence score for a trade based on its size relative to
 * available liquidity.
 *
 * Uses exponential decay so that:
 *  - ratio < 0.001  (tiny trade) → ~100
 *  - ratio = 0.5    (half the liquidity) → ~8
 *  - ratio ≥ 1      (exceeds liquidity)  → 0
 *
 * Formula: score = round(exp(−5 × amountIn / totalLiquidity) × 100), clamped to [0, 100].
 *
 * For V2: pass totalLiquidity = sqrt(reserveIn × reserveOut) or simply reserveIn.
 * For V3: pass totalLiquidity = liquidity (the active tick liquidity).
 *
 * Returns a plain number (0–100) suitable for UI display or filter thresholds.
 */
export function liquidityConfidenceScore(
  amountIn: bigint,
  totalLiquidity: bigint,
): number {
  if (totalLiquidity === 0n) return 0;
  if (amountIn === 0n) return 100;
  const ratio = Number(amountIn) / Number(totalLiquidity);
  return Math.min(100, Math.max(0, Math.round(Math.exp(-5 * ratio) * 100)));
}

/**
 * Return true if the computed price impact is within the acceptable threshold.
 *
 *   isTradeSafe(50, 100)  → true   (50 bps impact ≤ 100 bps max)
 *   isTradeSafe(150, 100) → false  (150 bps > 100 bps max)
 */
export function isTradeSafe(impactBps: number, maxImpactBps: number): boolean {
  return impactBps <= maxImpactBps;
}

export default {
  // V2
  v2GetAmountOut,
  v2GetAmountIn,
  v2PriceImpactBps,
  // V3
  encodeSqrtRatioX96,
  v3VirtualReserves,
  v3GetAmountOut,
  v3SlippageBps,
  feeTierToBps,
  // Cycle
  simulateCycleExact,
  // Safety
  liquidityConfidenceScore,
  isTradeSafe,
};
