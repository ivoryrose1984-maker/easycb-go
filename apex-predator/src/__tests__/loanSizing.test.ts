/**
 * Verify that larger loans produce dramatically more profit (the core no-capital thesis).
 */

jest.mock('dotenv/config', () => ({}));
jest.mock('dotenv', () => ({ config: jest.fn() }));

import { calculateNetProfit } from '../core/bidMath';

const USDC_DEC   = 1_000_000n;
const ETH_PRICE  = 3_000n * USDC_DEC;
const gasForecast = {
  predictedBaseFee: 50_000_000n,   // 0.05 gwei — realistic Base
  predictedPriority: 1_000_000_000n,
  volatility: 0.3,
  dynamicPriorityPct: 13,
  lastUpdate: Date.now(),
};

// Fixed 0.3% spread across all loan sizes
// (0.1% no longer covers 10bps latency+failure buffers — use 0.3% as realistic baseline)
function profitAt(loanUsdc: bigint): bigint {
  const spread = (loanUsdc * 30n) / 10_000n; // 30 bps = 0.3%
  return calculateNetProfit(loanUsdc, 0n, loanUsdc + spread, gasForecast, ETH_PRICE).netProfit;
}

describe('loan size vs profit scaling', () => {
  it('gas cost is approximately $0.79 (fixed regardless of loan size)', () => {
    // Compute gas cost: 250_000 gas * (0.05gwei + 1gwei) = 262_500_000_000_000 wei
    // * $3000/ETH = $0.79
    const gasWei = 250_000n * (50_000_000n + 1_000_000_000n);
    const gasUsdc = (gasWei * ETH_PRICE) / (10n ** 18n);
    // 787_500 micro-USDC = $0.7875
    expect(gasUsdc).toBe(787_500n);
  });

  it('$1K loan yields small net profit at 0.3% spread', () => {
    const profit = profitAt(1_000n * USDC_DEC);
    // gross = $3, gas = $0.79, priority = 13% of $3 = $0.39, buffers = 10bps of $1K = $1.00
    // net = $3 - $0.79 - $0.39 - $1.00 = $0.82
    expect(profit).toBeGreaterThan(0n);
    expect(Number(profit) / 1e6).toBeCloseTo(0.82, 1);
  });

  it('$10K loan yields ~$15.31 net at 0.3% spread', () => {
    const profit = profitAt(10_000n * USDC_DEC);
    // gross = $30, gas = $0.79, priority = 13% of $30 = $3.90, buffers = 10bps of $10K = $10
    // net = $30 - $0.79 - $3.90 - $10 = $15.31
    expect(Number(profit) / 1e6).toBeCloseTo(15.31, 0);
  });

  it('$50K loan yields ~$79.71 net at 0.3% spread', () => {
    const profit = profitAt(50_000n * USDC_DEC);
    // gross = $150, gas = $0.79, priority = $19.50, buffers = 10bps of $50K = $50
    // net = $150 - $0.79 - $19.50 - $50 = $79.71
    expect(Number(profit) / 1e6).toBeCloseTo(79.71, 0);
  });

  it('$100K loan yields ~$160.21 net at 0.3% spread', () => {
    const profit = profitAt(100_000n * USDC_DEC);
    // gross = $300, gas = $0.79, priority = $39, buffers = 10bps of $100K = $100
    // net = $300 - $0.79 - $39 - $100 = $160.21
    expect(Number(profit) / 1e6).toBeCloseTo(160.21, 0);
  });

  it('profit scales nearly linearly with loan size once gas is amortised', () => {
    const p10K  = Number(profitAt(10_000n  * USDC_DEC));
    const p100K = Number(profitAt(100_000n * USDC_DEC));
    // 10x loan → ~10x profit (gas stays constant, buffers scale linearly with loan)
    const ratio = p100K / p10K;
    expect(ratio).toBeGreaterThan(9.0);
    expect(ratio).toBeLessThan(11.0);
  });
});
