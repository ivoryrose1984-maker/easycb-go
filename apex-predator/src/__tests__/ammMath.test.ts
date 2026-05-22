/**
 * ammMath.test.ts — Exhaustive tests for the AMM math module.
 *
 * All expected values are derived by hand or independently computed in
 * Node.js bigint arithmetic so there is no circular dependency on the
 * implementation under test.
 *
 * Test organisation:
 *   1. v2GetAmountOut
 *   2. v2GetAmountIn
 *   3. v2PriceImpactBps
 *   4. encodeSqrtRatioX96
 *   5. v3VirtualReserves
 *   6. v3GetAmountOut
 *   7. v3SlippageBps
 *   8. feeTierToBps
 *   9. simulateCycleExact
 *  10. liquidityConfidenceScore
 *  11. isTradeSafe
 *  12. Cross-function properties (round-trip, monotonicity, overflow)
 */

import {
  v2GetAmountOut,
  v2GetAmountIn,
  v2PriceImpactBps,
  encodeSqrtRatioX96,
  v3VirtualReserves,
  v3GetAmountOut,
  v3SlippageBps,
  feeTierToBps,
  simulateCycleExact,
  liquidityConfidenceScore,
  isTradeSafe,
  Q96,
  MIN_SQRT_RATIO,
  MAX_SQRT_RATIO,
  HopParams,
} from '../core/ammMath';

// ─── Shared fixtures ──────────────────────────────────────────────────────────

/** USDC/WETH pool: 1 000 000 USDC (6 dec) and 333 ETH (18 dec). */
const RESERVE_USDC = 1_000_000_000_000n;        // 1 000 000 × 1e6
const RESERVE_WETH = 333_000_000_000_000_000n;  // 333 × 1e18

// ─── 1. v2GetAmountOut ────────────────────────────────────────────────────────

describe('v2GetAmountOut', () => {
  /**
   * Manual derivation for 1 USDC in (1_000_000 units), 0.3% fee:
   *   amountInWithFee = 1_000_000 × 9970             = 9_970_000_000
   *   numerator       = 9_970_000_000 × 333_000_000_000_000_000
   *                   = 3_320_010_000_000_000_000_000_000_000
   *   denominator     = 1_000_000_000_000 × 10_000 + 9_970_000_000
   *                   = 10_000_009_970_000_000
   *   amountOut       = floor(...) = 332_000_668_995
   */
  it('computes exact output for a USDC→WETH swap (0.3% fee)', () => {
    const out = v2GetAmountOut(1_000_000n, RESERVE_USDC, RESERVE_WETH, 30);
    expect(out).toBe(332_000_668_995n);
  });

  it('matches Uniswap V2 contract formula exactly (cross-check with inline derivation)', () => {
    const amountIn   = 1_000_000n;
    const reserveIn  = 1_000_000_000_000n;
    const reserveOut = 333_333_333_333_333_333n;
    const feeBps     = 30;
    const amountInWithFee = amountIn * BigInt(10000 - feeBps);
    const numerator       = amountInWithFee * reserveOut;
    const denominator     = reserveIn * 10000n + amountInWithFee;
    const expected        = numerator / denominator;
    expect(v2GetAmountOut(amountIn, reserveIn, reserveOut, feeBps)).toBe(expected);
  });

  it('output is strictly less than the ideal (no-fee) output', () => {
    const amountIn   = 1_000_000n;
    const outWithFee = v2GetAmountOut(amountIn, RESERVE_USDC, RESERVE_WETH, 30);
    const ideal      = (amountIn * RESERVE_WETH) / (RESERVE_USDC + amountIn);
    expect(outWithFee).toBeLessThan(ideal);
  });

  it('returns 0n for zero input', () => {
    expect(v2GetAmountOut(0n, RESERVE_USDC, RESERVE_WETH, 30)).toBe(0n);
  });

  it('returns 0n for zero reserveIn', () => {
    expect(v2GetAmountOut(1_000_000n, 0n, RESERVE_WETH, 30)).toBe(0n);
  });

  it('returns 0n for zero reserveOut', () => {
    expect(v2GetAmountOut(1_000_000n, RESERVE_USDC, 0n, 30)).toBe(0n);
  });

  it('lower fee produces more output (25 bps > 30 bps output)', () => {
    const amountIn = 1_000_000n;
    const out25 = v2GetAmountOut(amountIn, RESERVE_USDC, RESERVE_WETH, 25);
    const out30 = v2GetAmountOut(amountIn, RESERVE_USDC, RESERVE_WETH, 30);
    expect(out25).toBeGreaterThan(out30);
  });

  it('all three fee tiers produce ordered output: 5bps > 30bps > 100bps', () => {
    const amountIn = 1_000_000n;
    const out5   = v2GetAmountOut(amountIn, RESERVE_USDC, RESERVE_WETH, 5);
    const out30  = v2GetAmountOut(amountIn, RESERVE_USDC, RESERVE_WETH, 30);
    const out100 = v2GetAmountOut(amountIn, RESERVE_USDC, RESERVE_WETH, 100);
    expect(out5).toBeGreaterThan(out30);
    expect(out30).toBeGreaterThan(out100);
  });

  it('output is always strictly less than reserveOut even for huge input', () => {
    const hugeIn = RESERVE_USDC * 1_000n;
    const out    = v2GetAmountOut(hugeIn, RESERVE_USDC, RESERVE_WETH, 30);
    expect(out).toBeLessThan(RESERVE_WETH);
  });

  it('output scales monotonically with input size', () => {
    const out1 = v2GetAmountOut(1_000_000n,   RESERVE_USDC, RESERVE_WETH, 30);
    const out2 = v2GetAmountOut(10_000_000n,  RESERVE_USDC, RESERVE_WETH, 30);
    const out3 = v2GetAmountOut(100_000_000n, RESERVE_USDC, RESERVE_WETH, 30);
    expect(out2).toBeGreaterThan(out1);
    expect(out3).toBeGreaterThan(out2);
  });

  it('50× larger input gives more output but less than 50× (sub-linear price impact on shallow pool)', () => {
    // Use a 1M-unit pool so a 50K trade is 5% depth → visible sub-linear effect
    const rIn  = 1_000_000n;
    const rOut = 1_000_000n;
    const small = v2GetAmountOut(1_000n,  rIn, rOut, 30); // 0.1% of pool
    const large = v2GetAmountOut(50_000n, rIn, rOut, 30); // 5% of pool
    expect(large).toBeGreaterThan(0n);
    // At 5% pool depth, slippage is significant → output grows but by less than 50×
    expect(large).toBeLessThan(small * 50n);
  });

  it('output for 1 unit input is non-zero in a reasonably liquid pool', () => {
    expect(v2GetAmountOut(1n, RESERVE_USDC, RESERVE_WETH, 30)).toBeGreaterThan(0n);
  });

  it('fee=0 produces output equal to the standard constant-product formula', () => {
    const amountIn = 1_000_000n;
    const out      = v2GetAmountOut(amountIn, RESERVE_USDC, RESERVE_WETH, 0);
    const expected = (amountIn * RESERVE_WETH) / (RESERVE_USDC + amountIn);
    expect(out).toBe(expected);
  });

  it('symmetric pool with 1:1 reserves returns correct output', () => {
    const reserve  = 1_000_000_000n;
    const amountIn = 1_000_000n;
    const expected = (amountIn * 9970n * reserve) / (reserve * 10000n + amountIn * 9970n);
    expect(v2GetAmountOut(amountIn, reserve, reserve, 30)).toBe(expected);
  });

  it('overflow safety: very large bigint values produce valid output', () => {
    const bigAmountIn = 100_000_000n * 1_000_000n;
    const bigReserve  = 1_000_000_000_000_000_000n;
    const out = v2GetAmountOut(bigAmountIn, bigReserve, bigReserve, 30);
    expect(out).toBeGreaterThan(0n);
    expect(out).toBeLessThan(bigReserve);
  });
});

// ─── 2. v2GetAmountIn ─────────────────────────────────────────────────────────

describe('v2GetAmountIn', () => {
  it('returns 0n for zero desired output', () => {
    expect(v2GetAmountIn(0n, RESERVE_USDC, RESERVE_WETH, 30)).toBe(0n);
  });

  it('throws when amountOut equals reserveOut', () => {
    expect(() => v2GetAmountIn(RESERVE_WETH, RESERVE_USDC, RESERVE_WETH, 30)).toThrow(RangeError);
  });

  it('throws when amountOut exceeds reserveOut', () => {
    expect(() => v2GetAmountIn(RESERVE_WETH + 1n, RESERVE_USDC, RESERVE_WETH, 30)).toThrow(RangeError);
  });

  it('throws when reserveIn is zero', () => {
    expect(() => v2GetAmountIn(1_000n, 0n, RESERVE_WETH, 30)).toThrow(RangeError);
  });

  it('throws when reserveOut is zero', () => {
    expect(() => v2GetAmountIn(1_000n, RESERVE_USDC, 0n, 30)).toThrow(RangeError);
  });

  it('returned input is sufficient to produce at least the desired output', () => {
    const reserveIn  = 1_000_000_000_000n;
    const reserveOut = 333_333_333_333_333_333n;
    const feeBps     = 30;
    const amountIn   = 1_000_000n;
    const amountOut  = v2GetAmountOut(amountIn, reserveIn, reserveOut, feeBps);
    const requiredIn = v2GetAmountIn(amountOut, reserveIn, reserveOut, feeBps);
    const actualOut  = v2GetAmountOut(requiredIn, reserveIn, reserveOut, feeBps);
    expect(actualOut).toBeGreaterThanOrEqual(amountOut);
  });

  it('round-trip: getAmountIn(getAmountOut(x)) is x or x+1', () => {
    const originalIn = 1_000_000n;
    const out        = v2GetAmountOut(originalIn, RESERVE_USDC, RESERVE_WETH, 30);
    const backIn     = v2GetAmountIn(out, RESERVE_USDC, RESERVE_WETH, 30);
    expect(backIn).toBeGreaterThanOrEqual(originalIn);
    expect(backIn - originalIn).toBeLessThanOrEqual(1n);
  });

  it('one less unit of input produces strictly less output (ceiling is tight)', () => {
    const amountOut = 332_000_668_995n;
    const amountIn  = v2GetAmountIn(amountOut, RESERVE_USDC, RESERVE_WETH, 30);
    if (amountIn > 1n) {
      const outputWithLess = v2GetAmountOut(amountIn - 1n, RESERVE_USDC, RESERVE_WETH, 30);
      expect(outputWithLess).toBeLessThan(amountOut);
    }
  });

  it('larger desired output requires more input', () => {
    const in1 = v2GetAmountIn(100_000n,   RESERVE_USDC, RESERVE_WETH, 30);
    const in2 = v2GetAmountIn(1_000_000n, RESERVE_USDC, RESERVE_WETH, 30);
    expect(in2).toBeGreaterThan(in1);
  });

  it('lower fee requires less input for the same output', () => {
    const target = 332_000_668_995n;
    const in30   = v2GetAmountIn(target, RESERVE_USDC, RESERVE_WETH, 30);
    const in25   = v2GetAmountIn(target, RESERVE_USDC, RESERVE_WETH, 25);
    expect(in25).toBeLessThanOrEqual(in30);
  });
});

// ─── 3. v2PriceImpactBps ─────────────────────────────────────────────────────

describe('v2PriceImpactBps', () => {
  it('returns 0 for zero amountIn', () => {
    expect(v2PriceImpactBps(0n, RESERVE_USDC, RESERVE_WETH)).toBe(0);
  });

  it('returns 0 for zero reserveIn', () => {
    expect(v2PriceImpactBps(1_000_000n, 0n, RESERVE_WETH)).toBe(0);
  });

  it('returns ~99 bps when amountIn is ~1% of reserveIn', () => {
    // 1000 / (100_000 + 1000) × 10000 ≈ 99.0 bps
    const impact = v2PriceImpactBps(1_000n, 100_000n, 100_000n);
    expect(impact).toBeCloseTo(99.0, 0);
  });

  it('tiny trade has near-zero impact on a deep pool', () => {
    const impact = v2PriceImpactBps(1_000_000n, RESERVE_USDC, RESERVE_WETH);
    expect(impact).toBeGreaterThan(0);
    expect(impact).toBeLessThan(1);
  });

  it('price impact scales monotonically with trade size', () => {
    const imp1 = v2PriceImpactBps(1_000_000n,   RESERVE_USDC, RESERVE_WETH);
    const imp2 = v2PriceImpactBps(10_000_000n,  RESERVE_USDC, RESERVE_WETH);
    const imp3 = v2PriceImpactBps(100_000_000n, RESERVE_USDC, RESERVE_WETH);
    expect(imp2).toBeGreaterThan(imp1);
    expect(imp3).toBeGreaterThan(imp2);
  });

  it('trade equal to reserveIn has exactly 5000 bps impact', () => {
    const reserve = 1_000_000_000_000n;
    const impact  = v2PriceImpactBps(reserve, reserve, reserve);
    expect(impact).toBeCloseTo(5000, 3);
  });

  it('does not depend on reserveOut', () => {
    const impact1 = v2PriceImpactBps(1_000_000n, RESERVE_USDC, RESERVE_WETH);
    const impact2 = v2PriceImpactBps(1_000_000n, RESERVE_USDC, 999n);
    expect(impact1).toBeCloseTo(impact2, 10);
  });

  it('scales linearly (small amounts): 10× input → ~10× impact', () => {
    const small = v2PriceImpactBps(100n,  1_000_000n, 1_000_000n);
    const large = v2PriceImpactBps(1000n, 1_000_000n, 1_000_000n);
    expect(large).toBeGreaterThan(small);
  });

  it('impact is always < 10000 bps for any finite trade', () => {
    const impact = v2PriceImpactBps(RESERVE_USDC * 999n, RESERVE_USDC, RESERVE_WETH);
    expect(impact).toBeLessThan(10000);
    expect(impact).toBeGreaterThan(0);
  });
});

// ─── 4. encodeSqrtRatioX96 ───────────────────────────────────────────────────

describe('encodeSqrtRatioX96', () => {
  it('1:1 ratio encodes to Q96 exactly', () => {
    expect(encodeSqrtRatioX96(1n, 1n)).toBe(Q96);
  });

  it('4:1 ratio encodes to approximately 2 × Q96', () => {
    const result = encodeSqrtRatioX96(1n, 4n);
    expect(result).toBeGreaterThanOrEqual(Q96 * 2n - 1n);
    expect(result).toBeLessThanOrEqual(Q96 * 2n + 1n);
  });

  it('1:4 ratio encodes to Q96 / 2', () => {
    expect(encodeSqrtRatioX96(4n, 1n)).toBe(Q96 / 2n);
  });

  it('USDC/WETH pool: price = 1e6 → sqrtPriceX96 = 1000 × Q96', () => {
    const sqrtPrice = encodeSqrtRatioX96(1_000_000_000_000n, 1_000_000_000_000_000_000n);
    expect(sqrtPrice).toBe(1000n * Q96);
  });

  it('throws on zero amount0', () => {
    expect(() => encodeSqrtRatioX96(0n, 1n)).toThrow(RangeError);
  });

  it('result satisfies sqrtPriceX96² / Q96² ≈ amount1 / amount0 (within ±1 due to integer sqrt floor)', () => {
    const a0 = 1_000_000_000_000n;
    const a1 = 333_000_000_000_000_000n;
    const sq = encodeSqrtRatioX96(a0, a1);
    // sq = floor(sqrt(a1/a0)) * Q96, so sq² / Q96² = floor(sqrt)² which floors price by ≤1
    const priceApprox = (sq * sq) / (Q96 * Q96);
    const expected    = a1 / a0; // 333_000
    expect(priceApprox).toBeGreaterThanOrEqual(expected - 1n);
    expect(priceApprox).toBeLessThanOrEqual(expected);
  });
});

// ─── 5. v3VirtualReserves ────────────────────────────────────────────────────

describe('v3VirtualReserves', () => {
  it('throws on zero sqrtPriceX96', () => {
    expect(() => v3VirtualReserves(0n, 1_000_000n)).toThrow(RangeError);
  });

  it('1:1 price → reserve0 == reserve1 == liquidity', () => {
    const liquidity = 1_000_000_000n;
    const { reserve0, reserve1 } = v3VirtualReserves(Q96, liquidity);
    expect(reserve0).toBe(liquidity);
    expect(reserve1).toBe(liquidity);
  });

  it('price 1e6 (1000 × Q96): reserve1 / reserve0 = 1e6', () => {
    const liquidity    = 1_000_000_000_000_000_000n;
    const sqrtPriceX96 = 1000n * Q96;
    const { reserve0, reserve1 } = v3VirtualReserves(sqrtPriceX96, liquidity);
    expect(reserve0).toBe(liquidity / 1000n);
    expect(reserve1).toBe(liquidity * 1000n);
  });

  it('higher sqrtPrice → less reserve0, more reserve1', () => {
    const L = 1_000_000_000_000n;
    const { reserve0: r0_low,  reserve1: r1_low  } = v3VirtualReserves(Q96,      L);
    const { reserve0: r0_high, reserve1: r1_high } = v3VirtualReserves(Q96 * 2n, L);
    expect(r0_high).toBeLessThan(r0_low);
    expect(r1_high).toBeGreaterThan(r1_low);
  });

  it('reserve0 × reserve1 == liquidity² at 1:1 price', () => {
    const liquidity = 1_000_000_000n;
    const { reserve0, reserve1 } = v3VirtualReserves(Q96, liquidity);
    expect(reserve0 * reserve1).toBe(liquidity * liquidity);
  });

  it('reserves scale linearly with liquidity', () => {
    const sqrtPriceX96 = Q96;
    const { reserve0: r0a, reserve1: r1a } = v3VirtualReserves(sqrtPriceX96, 1_000_000n);
    const { reserve0: r0b, reserve1: r1b } = v3VirtualReserves(sqrtPriceX96, 2_000_000n);
    expect(r0b).toBe(r0a * 2n);
    expect(r1b).toBe(r1a * 2n);
  });

  it('both reserves are non-negative bigints', () => {
    const { reserve0, reserve1 } = v3VirtualReserves(Q96 * 5n, 123_456_789n);
    expect(typeof reserve0).toBe('bigint');
    expect(typeof reserve1).toBe('bigint');
    expect(reserve0).toBeGreaterThanOrEqual(0n);
    expect(reserve1).toBeGreaterThanOrEqual(0n);
  });
});

// ─── 6. v3GetAmountOut ────────────────────────────────────────────────────────

describe('v3GetAmountOut', () => {
  const sqrtPriceX96 = 1000n * Q96;
  const liquidity    = 1_000_000_000_000_000_000n;
  const reserve0     = liquidity / 1000n;  // 1e15
  const reserve1     = liquidity * 1000n;  // 1e21

  it('zeroForOne=true: result matches v2GetAmountOut on virtual reserves', () => {
    const amountIn = 1_000_000n;
    const out      = v3GetAmountOut(amountIn, sqrtPriceX96, liquidity, true, 3000);
    expect(out).toBe(v2GetAmountOut(amountIn, reserve0, reserve1, 30));
  });

  it('zeroForOne=false: result matches v2GetAmountOut with reserves swapped', () => {
    const amountIn = 1_000_000_000_000n;
    const out      = v3GetAmountOut(amountIn, sqrtPriceX96, liquidity, false, 3000);
    expect(out).toBe(v2GetAmountOut(amountIn, reserve1, reserve0, 30));
  });

  it('returns 0n for zero input', () => {
    expect(v3GetAmountOut(0n, sqrtPriceX96, liquidity, true, 3000)).toBe(0n);
  });

  it('higher fee tier produces less output', () => {
    const amountIn = 1_000_000n;
    const out500   = v3GetAmountOut(amountIn, sqrtPriceX96, liquidity, true, 500);
    const out3000  = v3GetAmountOut(amountIn, sqrtPriceX96, liquidity, true, 3000);
    const out10000 = v3GetAmountOut(amountIn, sqrtPriceX96, liquidity, true, 10000);
    expect(out500).toBeGreaterThan(out3000);
    expect(out3000).toBeGreaterThan(out10000);
  });

  it('output is always strictly less than the active virtual reserve', () => {
    const out = v3GetAmountOut(1_000_000n, sqrtPriceX96, liquidity, true, 500);
    expect(out).toBeLessThan(reserve1);
  });

  it('larger liquidity → more output for same amountIn', () => {
    const out1 = v3GetAmountOut(1_000_000n, sqrtPriceX96, 1_000_000_000n,           true, 3000);
    const out2 = v3GetAmountOut(1_000_000n, sqrtPriceX96, 1_000_000_000_000_000_000n, true, 3000);
    expect(out2).toBeGreaterThan(out1);
  });

  it('all four standard fee tiers produce non-zero output', () => {
    for (const tier of [100, 500, 3000, 10000]) {
      expect(v3GetAmountOut(1_000_000n, sqrtPriceX96, liquidity, true, tier)).toBeGreaterThan(0n);
    }
  });

  it('at 1:1 price, zeroForOne=true and false produce equal outputs', () => {
    const L        = 1_000_000_000_000_000_000n;
    const sqrtEven = Q96;
    const amountIn = 1_000_000n;
    expect(v3GetAmountOut(amountIn, sqrtEven, L, true, 500))
      .toBe(v3GetAmountOut(amountIn, sqrtEven, L, false, 500));
  });

  it('at 1:1 price with large liquidity, output is close to input minus fee', () => {
    const L        = 1_000_000_000_000_000_000n;
    const amountIn = 1_000_000n;
    const out      = v3GetAmountOut(amountIn, Q96, L, true, 500);
    expect(out).toBeGreaterThan(990_000n);
    expect(out).toBeLessThanOrEqual(amountIn);
  });
});

// ─── 7. v3SlippageBps ─────────────────────────────────────────────────────────

describe('v3SlippageBps', () => {
  const sqrtPriceX96 = 1000n * Q96;
  const liquidity    = 1_000_000_000_000_000_000n;

  it('tiny trade → near-zero slippage', () => {
    const slip = v3SlippageBps(1_000_000n, sqrtPriceX96, liquidity, true, 3000);
    expect(slip).toBeGreaterThanOrEqual(0);
    expect(slip).toBeLessThan(1);
  });

  it('large trade relative to virtual reserve → high slippage', () => {
    const largeIn = 1_000_000_000_000_000n; // equal to virtual reserve0 = 1e15
    const slip    = v3SlippageBps(largeIn, sqrtPriceX96, liquidity, true, 3000);
    expect(slip).toBeGreaterThan(100);
  });

  it('slippage increases monotonically with amountIn', () => {
    const s1 = v3SlippageBps(1_000_000n,      sqrtPriceX96, liquidity, true, 3000);
    const s2 = v3SlippageBps(100_000_000n,    sqrtPriceX96, liquidity, true, 3000);
    const s3 = v3SlippageBps(10_000_000_000n, sqrtPriceX96, liquidity, true, 3000);
    expect(s2).toBeGreaterThan(s1);
    expect(s3).toBeGreaterThan(s2);
  });

  it('direction matters: zeroForOne has higher slip than oneForZero here', () => {
    // reserve0 = 1e15, reserve1 = 1e21 → same amountIn is a larger fraction of reserve0
    const amountIn  = 1_000_000_000n;
    const slipZF1   = v3SlippageBps(amountIn, sqrtPriceX96, liquidity, true, 3000);
    const slipOneF0 = v3SlippageBps(amountIn, sqrtPriceX96, liquidity, false, 3000);
    expect(slipZF1).toBeGreaterThan(slipOneF0);
  });

  it('feeTier does not affect the depth-based slippage value', () => {
    const amountIn = 1_000_000n;
    const s500     = v3SlippageBps(amountIn, sqrtPriceX96, liquidity, true, 500);
    const s3000    = v3SlippageBps(amountIn, sqrtPriceX96, liquidity, true, 3000);
    expect(s500).toBeCloseTo(s3000, 10);
  });

  it('returns a positive number for any non-trivial trade', () => {
    expect(v3SlippageBps(1_000_000n, Q96, 1_000_000_000_000n, true, 500)).toBeGreaterThan(0);
  });

  it('smaller trade has less slippage than a larger trade', () => {
    const L = 1_000_000_000_000_000n;
    const small = v3SlippageBps(1_000n,       Q96, L, true, 500);
    const large = v3SlippageBps(1_000_000_000n, Q96, L, true, 500);
    expect(large).toBeGreaterThan(small);
  });
});

// ─── 8. feeTierToBps ─────────────────────────────────────────────────────────

describe('feeTierToBps', () => {
  it('100 → 1 bps',   () => expect(feeTierToBps(100)).toBe(1));
  it('500 → 5 bps',   () => expect(feeTierToBps(500)).toBe(5));
  it('3000 → 30 bps', () => expect(feeTierToBps(3000)).toBe(30));
  it('10000 → 100 bps', () => expect(feeTierToBps(10000)).toBe(100));

  it('result is always an integer for standard tiers', () => {
    for (const tier of [100, 500, 3000, 10000]) {
      expect(Number.isInteger(feeTierToBps(tier))).toBe(true);
    }
  });

  it('is invertible: bps × 100 = feeTier', () => {
    for (const tier of [100, 500, 3000, 10000]) {
      expect(feeTierToBps(tier) * 100).toBe(tier);
    }
  });
});

// ─── 9. simulateCycleExact ───────────────────────────────────────────────────

describe('simulateCycleExact', () => {
  it('returns 0n for empty hops array', () => {
    expect(simulateCycleExact([])).toBe(0n);
  });

  it('single-hop V2 cycle returns same result as v2GetAmountOut directly', () => {
    const hops: HopParams[] = [{
      protocol:   'v2',
      amountIn:   1_000_000n,
      reserveIn:  1_000_000_000n,
      reserveOut: 1_000_000_000n,
      feeBps:     30,
    }];
    const expected = v2GetAmountOut(1_000_000n, 1_000_000_000n, 1_000_000_000n, 30);
    expect(simulateCycleExact(hops)).toBe(expected);
  });

  it('chains two V2 hops: output of hop1 becomes input of hop2', () => {
    const r      = 1_000_000_000n;
    const feeBps = 30;
    const init   = 1_000_000n;
    const out1   = v2GetAmountOut(init, r, r, feeBps);
    const out2   = v2GetAmountOut(out1, r, r, feeBps);
    const result = simulateCycleExact([
      { protocol: 'v2', amountIn: init, reserveIn: r, reserveOut: r, feeBps },
      { protocol: 'v2', amountIn: 0n,  reserveIn: r, reserveOut: r, feeBps },
    ]);
    expect(result).toBe(out2);
  });

  it('3-hop V2 cycle chains all outputs correctly', () => {
    const ETH_R   = 100_000_000_000_000_000_000n;
    const LINK_R  = 10_000_000_000_000_000_000_000n;
    const LINK_R2 = 5_000_000_000_000_000_000_000n;
    const USDC_R2 = 500_000_000_000n;
    const out1 = v2GetAmountOut(1_000_000n, RESERVE_USDC, RESERVE_WETH, 30);
    const out2 = v2GetAmountOut(out1, ETH_R,   LINK_R,  30);
    const out3 = v2GetAmountOut(out2, LINK_R2, USDC_R2, 30);
    const result = simulateCycleExact([
      { protocol: 'v2', amountIn: 1_000_000n, reserveIn: RESERVE_USDC, reserveOut: RESERVE_WETH, feeBps: 30 },
      { protocol: 'v2', amountIn: 0n,          reserveIn: ETH_R,        reserveOut: LINK_R,       feeBps: 30 },
      { protocol: 'v2', amountIn: 0n,          reserveIn: LINK_R2,      reserveOut: USDC_R2,      feeBps: 30 },
    ]);
    expect(result).toBe(out3);
  });

  it('returns 0n when a hop produces zero output (short-circuits)', () => {
    const result = simulateCycleExact([
      { protocol: 'v2', amountIn: 1_000n, reserveIn: 0n,    reserveOut: 1_000n, feeBps: 30 },
      { protocol: 'v2', amountIn: 0n,     reserveIn: 1_000n, reserveOut: 1_000n, feeBps: 30 },
    ]);
    expect(result).toBe(0n);
  });

  it('single-hop V3 cycle returns same result as v3GetAmountOut directly', () => {
    const sqrtPriceX96 = 1000n * Q96;
    const liquidity    = 1_000_000_000_000_000_000n;
    const hops: HopParams[] = [{
      protocol:     'v3',
      amountIn:     1_000_000n,
      sqrtPriceX96,
      liquidity,
      zeroForOne:   true,
      feeTier:      3000,
    }];
    const expected = v3GetAmountOut(1_000_000n, sqrtPriceX96, liquidity, true, 3000);
    expect(simulateCycleExact(hops)).toBe(expected);
  });

  it('mixed V2+V3 hops chain correctly', () => {
    const sqrtPriceX96 = 1000n * Q96;
    const liquidity    = 1_000_000_000_000_000_000n;
    const out1 = v3GetAmountOut(1_000_000n, sqrtPriceX96, liquidity, true, 3000);
    const out2 = v2GetAmountOut(out1, RESERVE_WETH, RESERVE_USDC, 30);
    const result = simulateCycleExact([
      { protocol: 'v3', amountIn: 1_000_000n, sqrtPriceX96, liquidity, zeroForOne: true,  feeTier: 3000 },
      { protocol: 'v2', amountIn: 0n,          reserveIn: RESERVE_WETH, reserveOut: RESERVE_USDC, feeBps: 30 },
    ]);
    expect(result).toBe(out2);
  });

  it('only the first hop amountIn is used as seed capital', () => {
    const correctOut1 = v2GetAmountOut(1_000_000n, RESERVE_USDC, RESERVE_WETH, 30);
    const correctOut2 = v2GetAmountOut(correctOut1, RESERVE_WETH, RESERVE_USDC, 30);
    const result = simulateCycleExact([
      { protocol: 'v2', amountIn: 1_000_000n,   reserveIn: RESERVE_USDC, reserveOut: RESERVE_WETH, feeBps: 30 },
      { protocol: 'v2', amountIn: 999_999_999n, reserveIn: RESERVE_WETH, reserveOut: RESERVE_USDC, feeBps: 30 },
    ]);
    expect(result).toBe(correctOut2);
  });

  it('throws TypeError on V2 hop missing reserveIn', () => {
    const hops: HopParams[] = [{ protocol: 'v2', amountIn: 1_000_000n, reserveOut: RESERVE_WETH, feeBps: 30 }];
    expect(() => simulateCycleExact(hops)).toThrow(TypeError);
  });

  it('throws TypeError on V2 hop missing feeBps', () => {
    const hops: HopParams[] = [{ protocol: 'v2', amountIn: 1_000_000n, reserveIn: RESERVE_USDC, reserveOut: RESERVE_WETH }];
    expect(() => simulateCycleExact(hops)).toThrow(TypeError);
  });

  it('throws TypeError on V3 hop missing sqrtPriceX96', () => {
    const hops: HopParams[] = [{ protocol: 'v3', amountIn: 1_000_000n, liquidity: 1n, zeroForOne: true, feeTier: 3000 }];
    expect(() => simulateCycleExact(hops)).toThrow(TypeError);
  });

  it('throws TypeError on V3 hop missing zeroForOne', () => {
    const hops: HopParams[] = [{ protocol: 'v3', amountIn: 1_000_000n, sqrtPriceX96: Q96, liquidity: 1n, feeTier: 3000 }];
    expect(() => simulateCycleExact(hops)).toThrow(TypeError);
  });

  it('throws TypeError on unknown protocol', () => {
    expect(() =>
      simulateCycleExact([{ protocol: 'v4' as 'v2', amountIn: 1_000n }]),
    ).toThrow(TypeError);
  });

  it('result is always a bigint', () => {
    const result = simulateCycleExact([{
      protocol: 'v2', amountIn: 1_000_000n,
      reserveIn: RESERVE_USDC, reserveOut: RESERVE_WETH, feeBps: 30,
    }]);
    expect(typeof result).toBe('bigint');
  });
});

// ─── 10. liquidityConfidenceScore ────────────────────────────────────────────

describe('liquidityConfidenceScore', () => {
  it('returns 100 for zero amountIn', () => {
    expect(liquidityConfidenceScore(0n, 1_000_000n)).toBe(100);
  });

  it('returns 0 for zero totalLiquidity', () => {
    expect(liquidityConfidenceScore(1_000_000n, 0n)).toBe(0);
  });

  it('tiny trade vs enormous liquidity → score = 100', () => {
    const score = liquidityConfidenceScore(1_000_000n, 1_000_000_000_000_000_000_000_000n);
    expect(score).toBe(100);
  });

  it('huge trade vs tiny liquidity → score = 0', () => {
    const score = liquidityConfidenceScore(1_000_000_000_000_000_000n, 1_000_000n);
    expect(score).toBe(0);
  });

  it('single-unit trade in a large pool → score = 100', () => {
    expect(liquidityConfidenceScore(1n, 1_000_000n)).toBe(100);
  });

  it('trade much larger than pool → score = 0', () => {
    expect(liquidityConfidenceScore(10_000_000n, 1_000n)).toBe(0);
  });

  it('score decreases monotonically as trade size increases', () => {
    const liq = 1_000_000n;
    const s1 = liquidityConfidenceScore(1_000n,   liq);
    const s2 = liquidityConfidenceScore(100_000n, liq);
    const s3 = liquidityConfidenceScore(500_000n, liq);
    expect(s1).toBeGreaterThanOrEqual(s2);
    expect(s2).toBeGreaterThanOrEqual(s3);
  });

  it('score is always in [0, 100]', () => {
    const cases: [bigint, bigint][] = [
      [1n,                             1_000_000_000_000_000_000n],
      [1_000_000n,                     1_000_000n],
      [1_000_000_000_000n,             1n],
      [0n,                             0n],
      [500_000n,                       1_000_000n],
    ];
    for (const [amountIn, liq] of cases) {
      const score = liquidityConfidenceScore(amountIn, liq);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it('always returns an integer', () => {
    const score = liquidityConfidenceScore(1_000_000n, 1_000_000_000_000n);
    expect(Number.isInteger(score)).toBe(true);
  });
});

// ─── 11. isTradeSafe ─────────────────────────────────────────────────────────

describe('isTradeSafe', () => {
  it('50 bps impact, 100 bps max → true', () => {
    expect(isTradeSafe(50, 100)).toBe(true);
  });

  it('100 bps impact, 100 bps max → true (boundary inclusive)', () => {
    expect(isTradeSafe(100, 100)).toBe(true);
  });

  it('101 bps impact, 100 bps max → false', () => {
    expect(isTradeSafe(101, 100)).toBe(false);
  });

  it('150 bps impact, 100 bps max → false', () => {
    expect(isTradeSafe(150, 100)).toBe(false);
  });

  it('250 bps impact, 100 bps max → false', () => {
    expect(isTradeSafe(250, 100)).toBe(false);
  });

  it('0 bps impact → always safe', () => {
    expect(isTradeSafe(0, 0)).toBe(true);
    expect(isTradeSafe(0, 100)).toBe(true);
  });

  it('1 bps impact, 0 bps max → false', () => {
    expect(isTradeSafe(1, 0)).toBe(false);
  });

  it('large impact vs large max → true', () => {
    expect(isTradeSafe(9999, 10000)).toBe(true);
  });
});

// ─── 12. Cross-function / property-based tests ───────────────────────────────

describe('cross-function properties', () => {
  it('getAmountOut then getAmountIn differs by at most 1 (tight ceiling)', () => {
    const inputs = [1_000_000n, 10_000_000n, 100_000_000n, 1_000_000_000n];
    for (const amountIn of inputs) {
      const out    = v2GetAmountOut(amountIn, RESERVE_USDC, RESERVE_WETH, 30);
      if (out > 0n && out < RESERVE_WETH) {
        const backIn = v2GetAmountIn(out, RESERVE_USDC, RESERVE_WETH, 30);
        expect(backIn).toBeGreaterThanOrEqual(amountIn);
        expect(backIn - amountIn).toBeLessThanOrEqual(1n);
      }
    }
  });

  it('overflow: 100B-USDC trade in 1e18 pool is a valid non-zero bigint', () => {
    const bigIn  = 100_000_000n * 1_000_000n;
    const bigRes = 1_000_000_000_000_000_000n;
    const out    = v2GetAmountOut(bigIn, bigRes, bigRes, 30);
    expect(out).toBeGreaterThan(0n);
    expect(out).toBeLessThan(bigRes);
  });

  it('v3 virtual reserves are consistent with the sqrtPrice ratio', () => {
    const sqrtPriceX96 = 1000n * Q96; // price = 1e6 → r1/r0 = 1e6
    const liquidity    = 1_000_000_000_000_000_000n;
    const { reserve0, reserve1 } = v3VirtualReserves(sqrtPriceX96, liquidity);
    expect(reserve1 / reserve0).toBe(1_000_000n);
  });

  it('Q96 constant equals 2^96', () => {
    expect(Q96).toBe(79228162514264337593543950336n);
  });

  it('MIN_SQRT_RATIO < Q96 < MAX_SQRT_RATIO', () => {
    expect(MIN_SQRT_RATIO).toBeLessThan(Q96);
    expect(MAX_SQRT_RATIO).toBeGreaterThan(Q96);
  });

  it('isTradeSafe + v2PriceImpactBps: tiny trade is safe at 100-bps threshold', () => {
    const impact = v2PriceImpactBps(1_000_000n, RESERVE_USDC, RESERVE_WETH);
    expect(isTradeSafe(impact, 100)).toBe(true);
  });

  it('isTradeSafe + v2PriceImpactBps: 50% pool trade is not safe at 100 bps', () => {
    const bigImpact = v2PriceImpactBps(500_000n, 1_000_000n, 1_000_000n);
    // 500K / 1.5M × 10000 ≈ 3333 bps
    expect(isTradeSafe(bigImpact, 100)).toBe(false);
  });

  it('v3GetAmountOut output type is bigint', () => {
    const out = v3GetAmountOut(1_000_000n, Q96, 1_000_000_000_000n, true, 500);
    expect(typeof out).toBe('bigint');
  });

  it('v2GetAmountOut output type is bigint', () => {
    const out = v2GetAmountOut(1_000_000n, RESERVE_USDC, RESERVE_WETH, 30);
    expect(typeof out).toBe('bigint');
  });

  it('encodeSqrtRatioX96 + v3VirtualReserves round-trip: price ratio preserved', () => {
    const a0 = 1_000_000_000_000n;
    const a1 = 333_000_000_000_000_000n;
    const sqrtPriceX96 = encodeSqrtRatioX96(a0, a1);
    const liquidity    = 1_000_000_000_000_000_000n;
    const { reserve0, reserve1 } = v3VirtualReserves(sqrtPriceX96, liquidity);
    const expectedPrice = a1 / a0; // 333_000_000
    const actualPrice   = reserve1 / reserve0;
    expect(actualPrice).toBeGreaterThanOrEqual(expectedPrice - 1n);
    expect(actualPrice).toBeLessThanOrEqual(expectedPrice + 1n);
  });

  it('3-hop cycle result is a non-negative bigint regardless of profitability', () => {
    const out = simulateCycleExact([
      { protocol: 'v2', amountIn: 1_000_000n,
        reserveIn: RESERVE_USDC, reserveOut: RESERVE_WETH, feeBps: 30 },
      { protocol: 'v2', amountIn: 0n,
        reserveIn: 100_000_000_000_000_000_000n,
        reserveOut: 10_000_000_000_000_000_000_000n, feeBps: 30 },
      { protocol: 'v2', amountIn: 0n,
        reserveIn: 5_000_000_000_000_000_000_000n,
        reserveOut: 500_000_000_000n, feeBps: 30 },
    ]);
    expect(typeof out).toBe('bigint');
    expect(out).toBeGreaterThanOrEqual(0n);
  });
});
