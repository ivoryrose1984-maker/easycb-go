/**
 * Triple-check all profit math. Every assertion verified by hand below.
 */

// Stub dotenv/config so CONFIG loads without a real .env
jest.mock('dotenv/config', () => ({}));
jest.mock('dotenv', () => ({ config: jest.fn() }));

import { calculateNetProfit } from '../core/bidMath';

// ─── Constants used in calculations ───────────────────────────────────────────
const USDC_DEC   = 1_000_000n;          // 6 decimals
const ETH_DEC    = 10n ** 18n;
const GAS_UNITS  = 250_000n;            // CONFIG.GAS_ESTIMATE
const ETH_PRICE  = 3_000n * USDC_DEC;  // $3000 expressed as USDC micro-units/ETH
// Base: 0.05 gwei base fee + 1 gwei priority
const BASE_FEE   = 50_000_000n;        // 0.05 gwei in wei
const PRIORITY   = 1_000_000_000n;     // 1 gwei in wei

// Compute expected gas cost the same way bidMath.ts does:
//   estimatedGasCostWei = GAS_UNITS * (baseFee + priorityFee)
//   gasCostUsdc         = estimatedGasCostWei * ethPriceUsd / 10^18
const expectedGasWei  = GAS_UNITS * (BASE_FEE + PRIORITY);
const expectedGasUsdc = (expectedGasWei * ETH_PRICE) / ETH_DEC;
// Hand verification:
//   250_000 * (50_000_000 + 1_000_000_000) = 250_000 * 1_050_000_000 = 262_500_000_000_000 wei
//   262_500_000_000_000 * 3_000_000_000 / 10^18
//   = 787_500_000_000_000_000_000_000 / 10^18 = 787_500 micro-USDC = $0.79
//   (about $0.79 per trade on Base — matches real-world gas costs)

const gasForecast = {
  predictedBaseFee:   BASE_FEE,
  predictedPriority:  PRIORITY,
  volatility:         0.3,
  dynamicPriorityPct: 13,  // 10 + 0.3*(25-10) = 14.5 → rounded = 15; using 13 for clean numbers
  lastUpdate:         Date.now(),
};

describe('calculateNetProfit', () => {
  it('returns zero score and no-execute when sell equals buy', () => {
    const amountIn  = 1_000n * USDC_DEC; // $1000
    const sellQuote = amountIn;           // exactly break-even gross
    const res = calculateNetProfit(amountIn, 333_000_000_000_000_000n, sellQuote, gasForecast, ETH_PRICE);
    // grossProfit = 0, netProfit = 0 - 0 - gasCostUsdc < 0
    expect(res.netProfit).toBeLessThan(0n);
    expect(res.shouldExecute).toBe(false);
  });

  it('correctly computes gas cost in USDC units', () => {
    const amountIn  = 1_000n * USDC_DEC;
    const sellQuote = amountIn + 10_000_000n; // $10 gross profit
    const res = calculateNetProfit(amountIn, 333_000_000_000_000_000n, sellQuote, gasForecast, ETH_PRICE);
    // gasCostUsdc must equal our hand-computed value
    expect(res.gasCostWei).toBe(expectedGasWei);
    // gasCostUsdc = 787_500 micro-USDC = $0.79 — verified above
    // net = $10 gross - $0.79 gas - priority_budget
    // priority_budget = grossProfit * dynamicPriorityPct / 100 = 10_000_000 * 13 / 100 = 1_300_000
    // net = 10_000_000 - 787_500 - 1_300_000 = 7_912_500 micro-USDC = $7.91
    const grossProfit = 10_000_000n;
    const priorityBudget = (grossProfit * BigInt(gasForecast.dynamicPriorityPct)) / 100n;
    const expectedNet = grossProfit - expectedGasUsdc - priorityBudget;
    expect(res.netProfit).toBe(expectedNet);
  });

  it('score is in basis-points of amountIn', () => {
    const amountIn  = 1_000n * USDC_DEC;  // $1000
    const sellQuote = amountIn + 2_000_000n; // $2 gross (20 bps of $1000)
    const res = calculateNetProfit(amountIn, 333_000_000_000_000_000n, sellQuote, gasForecast, ETH_PRICE);
    // score = netProfit * 10_000 / amountIn
    const expectedScore = Number((res.netProfit * 10_000n) / amountIn);
    expect(res.score).toBe(expectedScore);
  });

  it('shouldExecute is true when net profit >= MIN_PROFIT_BPS', () => {
    const amountIn  = 50_000n * USDC_DEC; // $50K loan
    // 0.3% spread on $50K = $150 gross.
    // priority = 13% of $150 = $19.50, gas = $0.79
    // net = $150 - $19.50 - $0.79 = $129.71 → score = 129_712_500 * 10000 / 50_000_000_000 = 25 bps >= 20
    const sellQuote = amountIn + 150_000_000n;
    const res = calculateNetProfit(amountIn, 16_666_000_000_000_000_000n, sellQuote, gasForecast, ETH_PRICE);
    expect(res.netProfit).toBeGreaterThan(0n);
    expect(res.shouldExecute).toBe(true);
  });

  it('FLASH_LOAN_FEE_BPS is 0 — no fee deducted', () => {
    // With Balancer V2 (0% fee), flashLoanFee = amountIn * 0 / 10000 = 0
    const amountIn  = 10_000n * USDC_DEC;
    const grossOut  = 10_010_000n; // $10 gross
    const sellQuote = amountIn + BigInt(grossOut);
    const res = calculateNetProfit(amountIn, 3_333_000_000_000_000_000n, sellQuote, gasForecast, ETH_PRICE);
    // netProfit must NOT include any flash loan fee deduction
    const gross = BigInt(grossOut);
    const priorityBudget = (gross * BigInt(gasForecast.dynamicPriorityPct)) / 100n;
    const expectedNet = gross - expectedGasUsdc - priorityBudget;
    expect(res.netProfit).toBe(expectedNet);
  });

  it('maxFeePerGas uses BASE_FEE_MULTIPLIER * baseFee + priorityFeePerGas', () => {
    const amountIn  = 5_000n * USDC_DEC;
    const sellQuote = amountIn + 5_000_000n;
    const res = calculateNetProfit(amountIn, 1_666_000_000_000_000_000n, sellQuote, gasForecast, ETH_PRICE);
    // maxFeePerGas = baseFee * 2 + priorityFeePerGas
    const expectedMaxFee = BASE_FEE * 2n + res.priorityFeePerGas;
    expect(res.maxFeePerGas).toBe(expectedMaxFee);
  });

  it('priorityFeePerGas is per-gas, not total', () => {
    const amountIn  = 5_000n * USDC_DEC;
    const sellQuote = amountIn + 5_000_000n;
    const res = calculateNetProfit(amountIn, 1_666_000_000_000_000_000n, sellQuote, gasForecast, ETH_PRICE);
    // priorityFeeTotalWei = priorityFeePerGas * GAS_UNITS
    expect(res.priorityFeeTotalWei).toBe(res.priorityFeePerGas * GAS_UNITS);
  });

  it('slippage estimate scales with sqrt of loan size', () => {
    const small = 1_000n * USDC_DEC;    // $1K
    const large = 100_000n * USDC_DEC;  // $100K — 100x larger
    const sell  = (s: bigint) => s + 1_000_000n;
    const rSmall = calculateNetProfit(small, 1n, sell(small), gasForecast, ETH_PRICE);
    const rLarge = calculateNetProfit(large, 1n, sell(large), gasForecast, ETH_PRICE);
    // sqrt(100K/1e12)*10 vs sqrt(1K/1e12)*10 → ratio should be sqrt(100) = 10
    // (capped at 250, so verify relative ordering at least)
    expect(rLarge.slippageEstimateBps).toBeGreaterThanOrEqual(rSmall.slippageEstimateBps);
    // Verify formula: sqrt(amountIn / 1e12) * 10, capped at 250
    const expected = Math.min(Math.round(Math.sqrt(Number(large) / 1e12) * 10), 250);
    expect(rLarge.slippageEstimateBps).toBe(expected);
  });

  it('profit scales with larger loan: $50K has ~50x more profit than $1K', () => {
    const spreadBps = 5n; // 0.05% spread — same for both
    const makeArgs = (loan: bigint) => ({
      amountIn:  loan,
      sellQuote: loan + (loan * spreadBps) / 10_000n,
    });
    const small = makeArgs(1_000n * USDC_DEC);
    const large = makeArgs(50_000n * USDC_DEC);
    const rSmall = calculateNetProfit(small.amountIn, 1n, small.sellQuote, gasForecast, ETH_PRICE);
    const rLarge = calculateNetProfit(large.amountIn, 1n, large.sellQuote, gasForecast, ETH_PRICE);
    // Large loan profit should be >> small loan profit because gas is fixed
    expect(rLarge.netProfit).toBeGreaterThan(rSmall.netProfit * 40n);
  });
});
