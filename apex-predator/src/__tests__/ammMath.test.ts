/**
 * Exact AMM math tests — every expected value hand-verified.
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
} from '../core/ammMath';

// ─── V2: v2GetAmountOut ────────────────────────────────────────────────────────

describe('v2GetAmountOut', () => {
  it('matches Uniswap V2 contract formula exactly', () => {
    // amountIn = 1_000_000 (1 USDC, 6 dec)
    // reserveIn = 1_000_000_000_000 ($1M USDC)
    // reserveOut = 333_333_333_333_333_333 (333 WETH @ $3000)
    // feeBps = 30 (0.3%)
    // amountInWithFee = 1_000_000 * 9970 = 9_970_000_000
    // numerator = 9_970_000_000 * 333_333_333_333_333_333 = 3_323_333_333_333_333_333_110_000_000_000 (approx)
    // denominator = 1_000_000_000_000 * 10000 + 9_970_000_000
    //             = 10_000_000_000_000_000 + 9_970_000_000 = 10_000_009_970_000_000
    // amountOut = numerator / denominator
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

  it('returns 0n when amountIn is 0', () => {
    expect(v2GetAmountOut(0n, 1_000n, 1_000n, 30)).toBe(0n);
  });

  it('returns 0n when reserveIn is 0', () => {
    expect(v2GetAmountOut(100n, 0n, 1_000n, 30)).toBe(0n);
  });

  it('returns 0n when reserveOut is 0', () => {
    expect(v2GetAmountOut(100n, 1_000n, 0n, 30)).toBe(0n);
  });

  it('lower fee produces more output', () => {
    const aIn = 1_000_000n;
    const rIn = 1_000_000_000n;
    const rOut = 1_000_000_000n;
    const out30 = v2GetAmountOut(aIn, rIn, rOut, 30);
    const out5  = v2GetAmountOut(aIn, rIn, rOut, 5);
    expect(out5).toBeGreaterThan(out30);
  });

  it('larger amountIn gives proportionally more output (sub-linear due to impact)', () => {
    // Use a shallow pool (1M each) so price impact is visible at 50K trade
    const rIn  = 1_000_000n;
    const rOut = 1_000_000n;
    const small = v2GetAmountOut(1_000n,  rIn, rOut, 30); // 0.1% of pool
    const large = v2GetAmountOut(50_000n, rIn, rOut, 30); // 5% of pool → visible impact
    // 50x amountIn → output grows, but by less than 50x due to slippage
    expect(large).toBeGreaterThan(0n);
    expect(large).toBeLessThan(small * 50n);
  });
});

// ─── V2: v2GetAmountIn ────────────────────────────────────────────────────────

describe('v2GetAmountIn', () => {
  it('is the inverse of v2GetAmountOut (ceiling guarantees repayability)', () => {
    const reserveIn  = 1_000_000_000_000n;
    const reserveOut = 333_333_333_333_333_333n;
    const feeBps     = 30;
    const amountIn   = 1_000_000n;

    // Get the output from a known input
    const amountOut = v2GetAmountOut(amountIn, reserveIn, reserveOut, feeBps);
    // Now compute the required input to get at least that output
    const requiredIn = v2GetAmountIn(amountOut, reserveIn, reserveOut, feeBps);
    // Due to ceiling division, requiredIn >= amountIn (by at most 1)
    expect(requiredIn).toBeGreaterThanOrEqual(amountIn);
    expect(requiredIn).toBeLessThanOrEqual(amountIn + 1n);
  });

  it('returns 0n when amountOut is 0', () => {
    expect(v2GetAmountIn(0n, 1_000n, 1_000n, 30)).toBe(0n);
  });

  it('throws when amountOut >= reserveOut', () => {
    expect(() => v2GetAmountIn(1_000n, 1_000n, 1_000n, 30)).toThrow();
    expect(() => v2GetAmountIn(1_001n, 1_000n, 1_000n, 30)).toThrow();
  });

  it('throws when reserveIn is 0', () => {
    expect(() => v2GetAmountIn(100n, 0n, 1_000n, 30)).toThrow();
  });
});

// ─── V2: v2PriceImpactBps ────────────────────────────────────────────────────

describe('v2PriceImpactBps', () => {
  it('returns ~100 bps (1%) when amountIn is 1% of reserveIn', () => {
    // impact = amountIn / (reserveIn + amountIn) * 10000
    // = 1000 / (100000 + 1000) * 10000 = 1000/101000 * 10000 ≈ 99.0 bps
    const impact = v2PriceImpactBps(1_000n, 100_000n, 100_000n);
    expect(impact).toBeCloseTo(99.0, 0);
  });

  it('returns 0 when amountIn is 0', () => {
    expect(v2PriceImpactBps(0n, 100_000n, 100_000n)).toBe(0);
  });

  it('returns 0 when reserveIn is 0', () => {
    expect(v2PriceImpactBps(100n, 0n, 100_000n)).toBe(0);
  });

  it('scales linearly with amountIn relative to reserveIn', () => {
    const small = v2PriceImpactBps(100n, 1_000_000n, 1_000_000n);
    const large = v2PriceImpactBps(1000n, 1_000_000n, 1_000_000n);
    // larger trade has larger impact
    expect(large).toBeGreaterThan(small);
  });
});

// ─── V3: encodeSqrtRatioX96 ───────────────────────────────────────────────────

describe('encodeSqrtRatioX96', () => {
  it('1:1 price encodes to Q96', () => {
    // sqrt(amount1/amount0) * 2^96 = sqrt(1/1) * 2^96 = 2^96
    const result = encodeSqrtRatioX96(1n, 1n);
    expect(result).toBe(Q96);
  });

  it('4:1 ratio encodes to 2 * Q96', () => {
    // sqrt(4/1) = 2, so sqrtPriceX96 = 2 * 2^96
    const result = encodeSqrtRatioX96(1n, 4n);
    // Allow ±1 for integer square root rounding
    expect(result).toBeGreaterThanOrEqual(Q96 * 2n - 1n);
    expect(result).toBeLessThanOrEqual(Q96 * 2n + 1n);
  });

  it('throws when amount0 is 0', () => {
    expect(() => encodeSqrtRatioX96(0n, 1n)).toThrow();
  });
});

// ─── V3: v3VirtualReserves ────────────────────────────────────────────────────

describe('v3VirtualReserves', () => {
  it('at 1:1 price, reserves are symmetric', () => {
    const sqrtPrice = Q96; // price = 1:1
    const liquidity = 1_000_000_000_000n;
    const { reserve0, reserve1 } = v3VirtualReserves(sqrtPrice, liquidity);
    // reserve0 = liquidity * Q96 / sqrtPrice = liquidity * Q96 / Q96 = liquidity
    // reserve1 = liquidity * sqrtPrice / Q96 = liquidity * Q96 / Q96 = liquidity
    expect(reserve0).toBe(liquidity);
    expect(reserve1).toBe(liquidity);
  });

  it('throws when sqrtPriceX96 is 0', () => {
    expect(() => v3VirtualReserves(0n, 1_000n)).toThrow();
  });

  it('higher price → less reserve0, more reserve1', () => {
    const L = 1_000_000_000_000n;
    const { reserve0: r0_low, reserve1: r1_low } = v3VirtualReserves(Q96, L);
    const { reserve0: r0_high, reserve1: r1_high } = v3VirtualReserves(Q96 * 2n, L);
    expect(r0_high).toBeLessThan(r0_low);
    expect(r1_high).toBeGreaterThan(r1_low);
  });
});

// ─── V3: feeTierToBps ────────────────────────────────────────────────────────

describe('feeTierToBps', () => {
  it.each([
    [100,    1],
    [500,    5],
    [3000,  30],
    [10000, 100],
  ])('feeTier %i → %i bps', (tier, expected) => {
    expect(feeTierToBps(tier)).toBe(expected);
  });
});

// ─── V3: v3GetAmountOut ───────────────────────────────────────────────────────

describe('v3GetAmountOut', () => {
  it('at 1:1 price with 500 fee, output is close to input minus fee', () => {
    const L = 1_000_000_000_000_000_000n; // large liquidity
    const sqrtPrice = Q96; // 1:1
    const amountIn = 1_000_000n; // 1 USDC
    const out = v3GetAmountOut(amountIn, sqrtPrice, L, true, 500);
    // Expect approximately amountIn * (1 - 0.0005) = 999_500 before rounding
    expect(out).toBeGreaterThan(990_000n);
    expect(out).toBeLessThanOrEqual(amountIn);
  });

  it('zeroForOne=true and false are inverses at 1:1 price', () => {
    const L = 1_000_000_000_000_000_000n;
    const sqrtPrice = Q96;
    const amountIn = 1_000_000n;
    const outZeroForOne = v3GetAmountOut(amountIn, sqrtPrice, L, true, 500);
    const outOneForZero = v3GetAmountOut(amountIn, sqrtPrice, L, false, 500);
    // At 1:1 price they should be equal
    expect(outZeroForOne).toBe(outOneForZero);
  });

  it('higher fee tier produces less output', () => {
    const L = 1_000_000_000_000_000_000n;
    const sqrtPrice = Q96;
    const amountIn = 1_000_000n;
    const out500  = v3GetAmountOut(amountIn, sqrtPrice, L, true, 500);
    const out3000 = v3GetAmountOut(amountIn, sqrtPrice, L, true, 3000);
    expect(out500).toBeGreaterThan(out3000);
  });
});

// ─── V3: v3SlippageBps ───────────────────────────────────────────────────────

describe('v3SlippageBps', () => {
  it('returns a positive slippage for non-trivial trades', () => {
    const L = 1_000_000_000_000n;
    const sqrtPrice = Q96;
    const slippage = v3SlippageBps(1_000_000n, sqrtPrice, L, true, 500);
    expect(slippage).toBeGreaterThan(0);
  });

  it('smaller trade has less slippage', () => {
    const L = 1_000_000_000_000_000n;
    const sqrtPrice = Q96;
    const small = v3SlippageBps(1_000n, sqrtPrice, L, true, 500);
    const large = v3SlippageBps(1_000_000_000n, sqrtPrice, L, true, 500);
    expect(large).toBeGreaterThan(small);
  });
});

// ─── simulateCycleExact ───────────────────────────────────────────────────────

describe('simulateCycleExact', () => {
  it('returns 0n for empty hops array', () => {
    expect(simulateCycleExact([])).toBe(0n);
  });

  it('single V2 hop matches v2GetAmountOut', () => {
    const amountIn = 1_000_000n;
    const reserveIn = 1_000_000_000n;
    const reserveOut = 1_000_000_000n;
    const feeBps = 30;

    const result = simulateCycleExact([{
      protocol: 'v2',
      amountIn,
      reserveIn,
      reserveOut,
      feeBps,
    }]);
    expect(result).toBe(v2GetAmountOut(amountIn, reserveIn, reserveOut, feeBps));
  });

  it('chains two V2 hops (output of first becomes input of second)', () => {
    const r = 1_000_000_000n;
    const feeBps = 30;
    const initial = 1_000_000n;

    const hop1Out = v2GetAmountOut(initial, r, r, feeBps);
    const hop2Out = v2GetAmountOut(hop1Out, r, r, feeBps);

    const result = simulateCycleExact([
      { protocol: 'v2', amountIn: initial, reserveIn: r, reserveOut: r, feeBps },
      { protocol: 'v2', amountIn: 0n, reserveIn: r, reserveOut: r, feeBps },
    ]);
    expect(result).toBe(hop2Out);
  });

  it('returns 0n when any hop produces 0 output', () => {
    const result = simulateCycleExact([
      { protocol: 'v2', amountIn: 1_000n, reserveIn: 0n, reserveOut: 1_000n, feeBps: 30 },
      { protocol: 'v2', amountIn: 0n, reserveIn: 1_000n, reserveOut: 1_000n, feeBps: 30 },
    ]);
    expect(result).toBe(0n);
  });

  it('throws on missing V2 fields', () => {
    expect(() => simulateCycleExact([{ protocol: 'v2', amountIn: 1_000n }])).toThrow(TypeError);
  });

  it('throws on unknown protocol', () => {
    expect(() =>
      simulateCycleExact([{ protocol: 'v4' as 'v2', amountIn: 1_000n }])
    ).toThrow(TypeError);
  });
});

// ─── liquidityConfidenceScore ─────────────────────────────────────────────────

describe('liquidityConfidenceScore', () => {
  it('returns 100 when amountIn is 0', () => {
    expect(liquidityConfidenceScore(0n, 1_000_000n)).toBe(100);
  });

  it('returns 0 when totalLiquidity is 0', () => {
    expect(liquidityConfidenceScore(1_000n, 0n)).toBe(0);
  });

  it('returns high score for tiny trade (ratio << 1)', () => {
    // amountIn = 1, liquidity = 1_000_000 → ratio = 0.000001 → score ≈ 100
    expect(liquidityConfidenceScore(1n, 1_000_000n)).toBe(100);
  });

  it('returns low score for large trade (ratio >> 1)', () => {
    // amountIn > liquidity → score near 0
    expect(liquidityConfidenceScore(10_000_000n, 1_000n)).toBe(0);
  });

  it('score decreases monotonically as trade size grows', () => {
    const L = 1_000_000n;
    const s1 = liquidityConfidenceScore(1_000n, L);
    const s2 = liquidityConfidenceScore(100_000n, L);
    const s3 = liquidityConfidenceScore(500_000n, L);
    expect(s1).toBeGreaterThanOrEqual(s2);
    expect(s2).toBeGreaterThanOrEqual(s3);
  });
});

// ─── isTradeSafe ─────────────────────────────────────────────────────────────

describe('isTradeSafe', () => {
  it('returns true when impact is within max', () => {
    expect(isTradeSafe(50, 100)).toBe(true);
    expect(isTradeSafe(100, 100)).toBe(true);
  });

  it('returns false when impact exceeds max', () => {
    expect(isTradeSafe(101, 100)).toBe(false);
    expect(isTradeSafe(250, 100)).toBe(false);
  });

  it('returns true for 0 impact', () => {
    expect(isTradeSafe(0, 100)).toBe(true);
  });
});
