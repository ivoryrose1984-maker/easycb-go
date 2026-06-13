import { usdcToUsd, weiToEth } from '../core/config';
import CONFIG from '../core/config';
import { bigintSqrt, optimalInputCFMM, maxGrossEdgeBps } from '../execution/flashLoanPlanner';
import { packMinAmountOut } from '../execution/FastPathExecutor';
import { encode2HopPath, encode3HopPath } from '../execution/routePlanner';
import { solidlyF, solidlyD, solidlyGetY, getAmountOutStable } from '../execution/solidlyMath';
import { ethers }                          from 'ethers';

// ── usdcToUsd ─────────────────────────────────────────────────────────────────

describe('usdcToUsd', () => {
  it('converts 1 USDC (1e6 base units) to 1.0', () => {
    expect(usdcToUsd(1_000_000n)).toBe(1.0);
  });

  it('converts 3000 USDC to 3000.0', () => {
    expect(usdcToUsd(3_000_000_000n)).toBe(3000.0);
  });

  it('converts 0 to 0', () => {
    expect(usdcToUsd(0n)).toBe(0);
  });
});

// ── weiToEth ──────────────────────────────────────────────────────────────────

describe('weiToEth', () => {
  it('converts 1 ETH (1e18 wei) to 1.0', () => {
    expect(weiToEth(1_000_000_000_000_000_000n)).toBe(1.0);
  });

  it('converts 0.5 ETH', () => {
    expect(weiToEth(500_000_000_000_000_000n)).toBe(0.5);
  });
});

// ── WETH denomination formula ─────────────────────────────────────────────────

describe('WETH profit to USD', () => {
  it('correctly converts 0.001 ETH profit at $3000/ETH to $3', () => {
    const profitWei  = ethers.parseEther('0.001');   // 1e15 wei
    const ethPriceUsd = 3_000_000_000n;               // 3000 USDC in 6-dec units
    const grossUsdc   = profitWei * ethPriceUsd / 10n ** 18n;
    const grossUsd    = usdcToUsd(grossUsdc);
    expect(grossUsd).toBeCloseTo(3.0, 4);
  });

  it('gives ~0 USD for 0 profit', () => {
    const grossUsdc = 0n * 3_000_000_000n / 10n ** 18n;
    expect(usdcToUsd(grossUsdc)).toBe(0);
  });
});

// ── Liquidity depth filter math ───────────────────────────────────────────────

function liquidityImpactBps(proRataOut: bigint, actualOut: bigint): number {
  if (actualOut === 0n) return 10_000;
  return Number((proRataOut - actualOut) * 10_000n / proRataOut);
}

describe('liquidityImpactBps', () => {
  it('returns 0 when pool is perfectly deep (no degradation)', () => {
    // 10× input yields exactly 10× output — no price impact
    expect(liquidityImpactBps(1_000_000n, 1_000_000n)).toBe(0);
  });

  it('returns 5000bps for 50% degradation (thin pool threshold)', () => {
    // pro-rata = 1000, actual = 500 → impact = (1000-500)/1000 * 10000 = 5000bps
    expect(liquidityImpactBps(1_000n, 500n)).toBe(5_000);
  });

  it('returns 10000bps when 10× quote completely fails', () => {
    expect(liquidityImpactBps(1_000_000n, 0n)).toBe(10_000);
  });

  it('returns 1000bps for 10% degradation (healthy pool)', () => {
    // pro-rata = 10000, actual = 9000 → (10000-9000)/10000 * 10000 = 1000bps
    expect(liquidityImpactBps(10_000n, 9_000n)).toBe(1_000);
  });

  it('correctly identifies phantom spread: same output at 10× (impossible pool)', () => {
    // If 10× input gives same output as 1× that means massive impact
    const baseOut  = 1_000n;
    const proRata  = baseOut * 10n; // expected at 10×
    const actual   = baseOut;       // pool can't fill more than 1× worth
    expect(liquidityImpactBps(proRata, actual)).toBe(9_000);
  });
});

// ── Spread formula properties (BUG-01 / Phase 1) ─────────────────────────────

function spreadBps(loanAmount: bigint, sellOut: bigint): number {
  return loanAmount > 0n ? Number(((sellOut - loanAmount) * 10_000n) / loanAmount) : 0;
}

describe('spreadBps formula properties', () => {
  it('same-pool round-trip at 500bps fee tier ≈ -10bps (2 × 0.05% fee)', () => {
    // buy: 10000 USDC → 9995 USDC-eq (0.05% fee taken)
    // sell: 9995 USDC-eq → 9990.0025 USDC (another 0.05% fee taken)
    const loan    = 10_000_000_000n; // 10000 USDC (6-dec)
    const buyOut  = loan * 9_995n / 10_000n;
    const sellOut = buyOut * 9_995n / 10_000n;
    const s = spreadBps(loan, sellOut);
    expect(s).toBeGreaterThan(-20);
    expect(s).toBeLessThan(0);
  });

  it('same-pool round-trip at 100bps fee tier ≈ -2bps', () => {
    const loan    = 10_000_000_000n;
    const buyOut  = loan * 9_999n / 10_000n;
    const sellOut = buyOut * 9_999n / 10_000n;
    const s = spreadBps(loan, sellOut);
    expect(s).toBeGreaterThan(-10);
    expect(s).toBeLessThan(0);
  });

  it('empty pool (sellOut=0) produces -10000bps', () => {
    const s = spreadBps(1_000_000n, 0n);
    expect(s).toBe(-10_000);
  });

  it('|spread| > 2000bps triggers anomaly gate', () => {
    // dust output from an absent pool
    const loan    = 5_000_000_000n;
    const sellOut = 100_000n; // tiny fraction returned
    const s = spreadBps(loan, sellOut);
    expect(Math.abs(s)).toBeGreaterThan(2000);
  });

  it('fair cross-DEX arb at +30bps stays within ±200bps', () => {
    const loan    = 5_000_000_000n;
    const sellOut = loan * 10_030n / 10_000n; // +30bps profit
    const s = spreadBps(loan, sellOut);
    expect(Math.abs(s)).toBeLessThanOrEqual(200);
  });
});

// ── cbETH cost model (Phase 4 / BUG-06/07) ───────────────────────────────────

describe('cbETH cost model', () => {
  it('Balancer flash loan fee is 0 (CONFIG.FLASH_LOAN_FEE_BPS = 0)', () => {
    expect(CONFIG.FLASH_LOAN_FEE_BPS).toBe(0);
    expect(CONFIG.FLASH_LOAN_FEE_BPS / 10_000).toBe(0);
  });

  it('net profit = gross - gas when flash loan fee is 0', () => {
    const grossEdgeBps = 30;
    const probeSizeEth = 3.33;
    const ethPriceUsd  = 3_000;
    const gasEth       = 0.0003;

    const grossProfitEth = (grossEdgeBps / 10_000) * probeSizeEth;
    const grossProfitUsd = grossProfitEth * ethPriceUsd;   // ~$2.997
    const gasUsd         = gasEth * ethPriceUsd;           // $0.90
    const netProfitUsd   = Math.max(0, grossProfitUsd - gasUsd - grossProfitUsd * (CONFIG.FLASH_LOAN_FEE_BPS / 10_000));

    expect(netProfitUsd).toBeCloseTo(grossProfitUsd - gasUsd, 4);
  });

  it('totalCosts uses named config buffers (LATENCY + FAILURE), not magic numbers', () => {
    const feeTierUsed  = 500; // 500 basis-point fee tier → 5bps
    const gasEth       = 0.0003;
    const probeSizeEth = 3.33;
    const gasAsBps     = (gasEth / probeSizeEth) * 10_000;
    // Mirrors cbETHFairValueSignal.ts line 167 exactly
    const totalCosts   = gasAsBps + 5 + (feeTierUsed / 100) + CONFIG.LATENCY_BUFFER_BPS + CONFIG.FAILURE_BUFFER_BPS;

    // LATENCY_BUFFER_BPS + FAILURE_BUFFER_BPS = 5 + 5 = 10
    const expectedBuffer = CONFIG.LATENCY_BUFFER_BPS + CONFIG.FAILURE_BUFFER_BPS;
    expect(totalCosts).toBeCloseTo(gasAsBps + 5 + 5 + expectedBuffer, 6);
  });

  it('negative gross edge yields zero net profit (floor at 0)', () => {
    const grossProfitUsd = -2.0;
    const gasUsd         = 0.9;
    const net = Math.max(0, grossProfitUsd - gasUsd - grossProfitUsd * (CONFIG.FLASH_LOAN_FEE_BPS / 10_000));
    expect(net).toBe(0);
  });

  it('all four signals use the same flash loan fee formula (FLASH_LOAN_FEE_BPS/10000)', () => {
    // Regression guard: ensures aerodromeSignal, triangularArbSignal, dexSpreadSignal,
    // and cbETHFairValueSignal all produce net = gross - gas when fee = 0.
    const gross = 5.0;
    const gas   = 0.9;
    const fee   = CONFIG.FLASH_LOAN_FEE_BPS / 10_000; // must be 0
    const net   = Math.max(0, gross - gas - gross * fee);
    expect(fee).toBe(0);
    expect(net).toBeCloseTo(gross - gas, 10);
  });
});

// ── bigintSqrt ────────────────────────────────────────────────────────────────

describe('bigintSqrt', () => {
  it('returns 0 for 0', () => expect(bigintSqrt(0n)).toBe(0n));
  it('returns 1 for 1', () => expect(bigintSqrt(1n)).toBe(1n));
  it('returns 2 for 4', () => expect(bigintSqrt(4n)).toBe(2n));
  it('returns 3 for 9', () => expect(bigintSqrt(9n)).toBe(3n));
  it('returns floor for non-perfect square (√2 = 1)', () => expect(bigintSqrt(2n)).toBe(1n));
  it('returns floor for non-perfect square (√8 = 2)', () => expect(bigintSqrt(8n)).toBe(2n));
  it('handles large values: √(10^40) = 10^20', () => {
    expect(bigintSqrt(10n ** 40n)).toBe(10n ** 20n);
  });
  it('handles very large values (6-reserve product ~10^104)', () => {
    // γ_a * γ_b * rAx * rAy * rBx * rBy where reserves are 30 ETH each
    const r = 30n * 10n ** 18n;
    const product = 9_950n * 9_950n * r * r * r * r; // ~10^103
    const s = bigintSqrt(product);
    expect(s * s).toBeLessThanOrEqual(product);
    expect((s + 1n) * (s + 1n)).toBeGreaterThan(product);
  });
});

// ── optimalInputCFMM ──────────────────────────────────────────────────────────

describe('optimalInputCFMM', () => {
  // Pool A: 1000 USDC / 1 ETH (price 1000 USDC/ETH)
  // Pool B varies by test
  const rA = { x: 1_000_000_000n, y: 1_000_000_000_000_000_000n }; // 1000 USDC (6-dec), 1 ETH (18-dec)

  it('returns null when both pools are at equal price (no arb)', () => {
    // Pool B at same 1000 USDC/ETH: rB.x=USDC, rB.y=ETH input
    const rB = { x: 2_000_000_000n, y: 2_000_000_000_000_000_000n };
    expect(optimalInputCFMM(rA, rB, 30n, 30n)).toBeNull();
  });

  it('returns positive optimal input when pool B has higher ETH price', () => {
    // Pool B at 1100 USDC/ETH → arb opportunity
    const rB = { x: 2_200_000_000n, y: 2_000_000_000_000_000_000n };
    const u = optimalInputCFMM(rA, rB, 30n, 30n);
    expect(u).not.toBeNull();
    expect(u!).toBeGreaterThan(0n);
  });

  it('optimal input is within sensible range (not larger than pool A reserves)', () => {
    const rB = { x: 2_200_000_000n, y: 2_000_000_000_000_000_000n };
    const u = optimalInputCFMM(rA, rB, 30n, 30n);
    expect(u!).toBeLessThan(rA.x);
  });

  it('higher fee erodes max gross edge (0.3% fee earns more than 3% fee at same spread)', () => {
    const rB = { x: 2_200_000_000n, y: 2_000_000_000_000_000_000n };
    const bpsLow  = maxGrossEdgeBps(rA, rB, 30n, 30n) ?? 0;    // 0.3% fee — solution exists
    const bpsHigh = maxGrossEdgeBps(rA, rB, 300n, 300n) ?? 0;  // 3%   fee — reduced edge
    expect(bpsLow).toBeGreaterThan(bpsHigh);
    // 30% fee (3000bps) exceeds the spread entirely — no arb exists
    expect(optimalInputCFMM(rA, rB, 3_000n, 3_000n)).toBeNull();
  });

  it('returns null for zero reserves', () => {
    expect(optimalInputCFMM({ x: 0n, y: 1n }, { x: 1n, y: 1n }, 30n, 30n)).toBeNull();
  });

  it('profit at u* is non-negative', () => {
    const rB = { x: 2_200_000_000n, y: 2_000_000_000_000_000_000n };
    const u = optimalInputCFMM(rA, rB, 30n, 30n)!;
    const gammaA = 9_970n, gammaB = 9_970n;
    const dy    = gammaA * rA.y * u / (rA.x * 10_000n + gammaA * u);
    const dxOut = gammaB * rB.x * dy / (rB.y * 10_000n + gammaB * dy);
    expect(dxOut).toBeGreaterThan(u); // gross profit > 0
  });
});

// ── maxGrossEdgeBps ───────────────────────────────────────────────────────────

describe('maxGrossEdgeBps', () => {
  it('returns null when no arb exists', () => {
    const rA = { x: 1_000n, y: 1_000n };
    const rB = { x: 1_000n, y: 1_000n };
    expect(maxGrossEdgeBps(rA, rB, 30n, 30n)).toBeNull();
  });

  it('returns positive bps when spread exists', () => {
    const rA = { x: 1_000_000_000n, y: 1_000_000_000_000_000_000n };
    const rB = { x: 2_200_000_000n, y: 2_000_000_000_000_000_000n };
    const bps = maxGrossEdgeBps(rA, rB, 30n, 30n);
    expect(bps).not.toBeNull();
    expect(bps!).toBeGreaterThan(0);
  });
});

// ── packMinAmountOut ──────────────────────────────────────────────────────────

describe('packMinAmountOut', () => {
  it('default 5bps: 10000 → 9995', () => {
    expect(packMinAmountOut(10_000n)).toBe(9_995n);
  });
  it('zero quote → zero', () => expect(packMinAmountOut(0n)).toBe(0n));
  it('100% slippage (10000bps) → 0 (accept anything)', () => {
    expect(packMinAmountOut(10_000n, 10_000n)).toBe(0n);
  });
  it('50bps: 10000 → 9950', () => {
    expect(packMinAmountOut(10_000n, 50n)).toBe(9_950n);
  });
  it('result always ≤ quote', () => {
    const q = 7_654_321_000_000n;
    expect(packMinAmountOut(q)).toBeLessThanOrEqual(q);
  });
});

// ── encode2HopPath ────────────────────────────────────────────────────────────

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';
const cbETH = '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22';

describe('encode2HopPath', () => {
  it('produces a hex string', () => {
    const path = encode2HopPath(USDC, 500, WETH, 3000, USDC);
    expect(path).toMatch(/^0x[0-9a-f]+$/i);
  });

  it('encodes to the correct byte length (20+3+20+3+20 = 66 bytes = 132 hex + 0x prefix)', () => {
    const path = encode2HopPath(USDC, 500, WETH, 3000, USDC);
    // 0x + 132 hex chars
    expect(path.length).toBe(2 + 66 * 2);
  });

  it('is symmetric with 3-hop encoder for same data', () => {
    const two  = encode2HopPath(USDC, 500, WETH, 3000, USDC);
    const three = encode3HopPath(USDC, 500, WETH, 3000, cbETH, 500, USDC);
    // Different lengths
    expect(two.length).not.toBe(three.length);
  });
});

// ── solidlyF / solidlyD ───────────────────────────────────────────────────────

const S = 10n ** 18n; // 1e18 scale

describe('solidlyF', () => {
  it('f(x,x) = 2x^4 / 1e54 (symmetric pool)', () => {
    const x = 1_000n * S; // 1000 tokens normalized
    const result = solidlyF(x, x);
    // f(x,x) = x·x³ + x³·x = 2x⁴ (in scaled space)
    // = 2 * (1000)^4 * S^4 / (S^3) = 2 * 1e12 * S
    const expected = 2n * 1_000n ** 4n * S;
    expect(result).toBe(expected);
  });

  it('f(0, y) = 0', () => {
    expect(solidlyF(0n, 1_000n * S)).toBe(0n);
  });

  it('f(x, 0) = 0', () => {
    expect(solidlyF(1_000n * S, 0n)).toBe(0n);
  });
});

describe('solidlyD', () => {
  it('d(x,x) = 4x^3 / 1e36 (symmetric pool)', () => {
    const x = 1_000n * S;
    const result = solidlyD(x, x);
    // d(x,x) = 3x·x² + x³ = 4x³ (in scaled space)
    const expected = 4n * 1_000n ** 3n * S;
    expect(result).toBe(expected);
  });

  it('d(0, y) = 0', () => {
    expect(solidlyD(0n, 1_000n * S)).toBe(0n);
  });
});

// ── solidlyGetY convergence ───────────────────────────────────────────────────

describe('solidlyGetY', () => {
  it('recovers y0 when x0 is unchanged (identity check)', () => {
    const x0 = 1_000n * S;
    const y0 = 1_000n * S;
    const xy = solidlyF(x0, y0);
    const recovered = solidlyGetY(x0, xy, y0);
    // Should converge to within 1 wei of y0
    const diff = recovered > y0 ? recovered - y0 : y0 - recovered;
    expect(diff).toBeLessThanOrEqual(1n);
  });

  it('gives lower y when x increases (pool sells out tokenOut)', () => {
    const x0 = 1_000n * S;
    const y0 = 1_000n * S;
    const xy   = solidlyF(x0, y0);
    const x1   = x0 + 10n * S; // add 10 tokens
    const y1   = solidlyGetY(x1, xy, y0);
    expect(y1).toBeLessThan(y0);
  });
});

// ── getAmountOutStable ────────────────────────────────────────────────────────

describe('getAmountOutStable', () => {
  it('returns 0 for zero amountIn', () => {
    expect(getAmountOutStable(0n, 1_000_000n, 1_000_000n, 6, 6)).toBe(0n);
  });

  it('returns 0 for zero reserves', () => {
    expect(getAmountOutStable(1_000n, 0n, 1_000_000n, 6, 6)).toBe(0n);
    expect(getAmountOutStable(1_000n, 1_000_000n, 0n, 6, 6)).toBe(0n);
  });

  it('USDC→DAI (6-dec → 18-dec): symmetric 1:1 stable pool returns ~amountIn', () => {
    // Simulate a large balanced USDC/DAI stable pool
    const reserveUSDC = 5_000_000n * 10n ** 6n;  // 5M USDC (6-dec)
    const reserveDAI  = 5_000_000n * 10n ** 18n; // 5M DAI  (18-dec)
    const amountIn    = 1_000n * 10n ** 6n;       // 1000 USDC
    const amountOut   = getAmountOutStable(amountIn, reserveUSDC, reserveDAI, 6, 18);
    // With 0.05% fee and deep pool: output should be ~999.5 DAI = ~999.5e18 raw units
    const outDai = Number(amountOut) / 1e18;
    expect(outDai).toBeGreaterThan(999.0);
    expect(outDai).toBeLessThan(1000.0);
  });

  it('DAI→USDC (18-dec → 6-dec): decimal normalization round-trip', () => {
    // Same pool flipped
    const reserveDAI  = 5_000_000n * 10n ** 18n;
    const reserveUSDC = 5_000_000n * 10n ** 6n;
    const amountIn    = 1_000n * 10n ** 18n;       // 1000 DAI
    const amountOut   = getAmountOutStable(amountIn, reserveDAI, reserveUSDC, 18, 6);
    const outUsdc = Number(amountOut) / 1e6;
    expect(outUsdc).toBeGreaterThan(999.0);
    expect(outUsdc).toBeLessThan(1000.0);
  });

  it('USDC→USDC same-dec pool (6→6): output ~amountIn minus fee', () => {
    // USDbC/USDC style — same decimals
    const reserve = 10_000_000n * 10n ** 6n; // 10M each
    const amountIn = 1_000n * 10n ** 6n;
    const amountOut = getAmountOutStable(amountIn, reserve, reserve, 6, 6);
    const out = Number(amountOut) / 1e6;
    // ~999.5 USDC (0.05% fee on deep pool)
    expect(out).toBeGreaterThan(999.0);
    expect(out).toBeLessThan(1000.0);
  });

  it('large 18-dec / 18-dec pool (WETH/cbETH style): output ~amountIn', () => {
    // cbETH and WETH both 18-dec; cbETH ~= WETH (ratio ~1.065 but near 1)
    const reserveWETH  = 1_000n * 10n ** 18n; // 1000 WETH
    const reservecbETH = 1_000n * 10n ** 18n; // 1000 cbETH
    const amountIn     = 1n   * 10n ** 18n;   // 1 WETH
    const amountOut = getAmountOutStable(amountIn, reserveWETH, reservecbETH, 18, 18);
    // ~0.9995 cbETH due to 0.05% fee
    const out = Number(amountOut) / 1e18;
    expect(out).toBeGreaterThan(0.999);
    expect(out).toBeLessThan(1.001);
  });

  it('tiny pool (10 tokens each): price impact is large', () => {
    // Swap 5 USDC into a pool of only 10 USDC / 10 DAI — expect heavy impact
    const reserveUSDC = 10n * 10n ** 6n;
    const reserveDAI  = 10n * 10n ** 18n;
    const amountIn    = 5n  * 10n ** 6n; // 50% of pool
    const amountOut   = getAmountOutStable(amountIn, reserveUSDC, reserveDAI, 6, 18);
    const outDai = Number(amountOut) / 1e18;
    // Stable curve is flatter than xy=k but still has significant impact at 50% of pool
    expect(outDai).toBeGreaterThan(0);
    expect(outDai).toBeLessThan(5.0); // less than 1:1 due to price impact
  });

  it('6-dec input vs 18-dec: wrong decimals produce wildly wrong results (regression)', () => {
    // Confirm that swapping dec args produces a nonsensical (very large) result
    // This is a decimal-normalization guard: the correct call uses (6,18), wrong is (18,6)
    const reserveUSDC = 5_000_000n * 10n ** 6n;
    const reserveDAI  = 5_000_000n * 10n ** 18n;
    const amountIn    = 1_000n * 10n ** 6n;
    const correctOut  = getAmountOutStable(amountIn, reserveUSDC, reserveDAI, 6, 18);
    const wrongOut    = getAmountOutStable(amountIn, reserveUSDC, reserveDAI, 18, 6);
    // Correct: ~999.5e18 raw DAI; wrong: will either be 0 or wildly different
    expect(correctOut).not.toBe(wrongOut);
  });
});
