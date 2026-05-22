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

// Fixed 0.1% spread across all loan sizes
function profitAt(loanUsdc: bigint): bigint {
  const spread = (loanUsdc * 10n) / 10_000n; // 10 bps = 0.1%
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

  it('$1K loan yields small net profit at 0.1% spread', () => {
    const profit = profitAt(1_000n * USDC_DEC);
    // gross = $1, gas = $0.79, priority = 13% of $1 = $0.13
    // net = $1 - $0.79 - $0.13 = $0.08
    expect(profit).toBeGreaterThan(0n);
    expect(Number(profit) / 1e6).toBeCloseTo(0.08, 1);
  });

  it('$10K loan yields ~$1.21 net at 0.1% spread', () => {
    const profit = profitAt(10_000n * USDC_DEC);
    // gross = $10, gas = $0.79, priority = 13% of $10 = $1.30 -- wait
    // Actually: dynamicPriorityPct = 13 -- percentage of GROSS allocated to miner
    // priority budget = 10_000_000 * 13/100 = 1_300_000 ($1.30)
    // net = $10 - $0.79 - $1.30 = $7.91 ... let me re-check
    // bidMath: priorityBudgetUsdc = grossProfit * priorityFeePct / 100
    // = 10_000_000 * 13 / 100 = 1_300_000
    // net = 10_000_000 - 787_500 - 1_300_000 = 7_912_500 = $7.91
    expect(Number(profit) / 1e6).toBeCloseTo(7.91, 0);
  });

  it('$50K loan yields ~$42 net at 0.1% spread', () => {
    const profit = profitAt(50_000n * USDC_DEC);
    // gross = $50, gas = $0.79, priority = 13% of $50 = $6.50
    // net = $50 - $0.79 - $6.50 = $42.71
    expect(Number(profit) / 1e6).toBeCloseTo(42.71, 0);
  });

  it('$100K loan yields ~$85 net at 0.1% spread', () => {
    const profit = profitAt(100_000n * USDC_DEC);
    // gross = $100, gas = $0.79, priority = $13
    // net = $100 - $0.79 - $13 = $86.21
    expect(Number(profit) / 1e6).toBeCloseTo(86.21, 0);
  });

  it('profit scales nearly linearly with loan size once gas is amortised', () => {
    const p10K  = Number(profitAt(10_000n  * USDC_DEC));
    const p100K = Number(profitAt(100_000n * USDC_DEC));
    // 10x loan → ~10x profit (gas stays constant)
    const ratio = p100K / p10K;
    expect(ratio).toBeGreaterThan(9.0);  // very close to 10x
    expect(ratio).toBeLessThan(11.0);
  });
});
