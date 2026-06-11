// Risk layer tests — circuit breaker grace period, loss limits, competition windows.
// Telegram is uninitialized here so alertCircuitBreaker() resolves as a no-op.

import { ethers } from 'ethers';
import {
  checkCircuitBreaker,
  setInitialBalance,
  isCircuitBroken,
  resetCircuitBreaker,
} from '../risk/circuitBreaker';
import { checkTradeAllowed, recordLoss, getDailyLoss } from '../risk/lossLimits';
import { getCompetitionWindow, adjustedThreshold } from '../core/clock';
import CONFIG from '../core/config';

// ── Circuit breaker — 3-breach grace period ───────────────────────────────────

function mockProvider(balanceWei: bigint): ethers.Provider {
  return { getBalance: async () => balanceWei } as unknown as ethers.Provider;
}

describe('circuitBreaker grace period', () => {
  const ONE_ETH  = ethers.parseEther('1');
  const DRAWDOWN = ethers.parseEther('0.4'); // 60% drawdown ≥ 50% threshold

  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    resetCircuitBreaker();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    resetCircuitBreaker();
  });

  it('does not trigger without an initial balance', async () => {
    await checkCircuitBreaker(mockProvider(0n), '0xabc');
    expect(isCircuitBroken()).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('does not halt on the first or second breach (grace)', async () => {
    setInitialBalance(ONE_ETH);
    await checkCircuitBreaker(mockProvider(DRAWDOWN), '0xabc'); // breach 1
    await checkCircuitBreaker(mockProvider(DRAWDOWN), '0xabc'); // breach 2
    expect(isCircuitBroken()).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('halts on the third consecutive breach', async () => {
    setInitialBalance(ONE_ETH);
    await checkCircuitBreaker(mockProvider(DRAWDOWN), '0xabc');
    await checkCircuitBreaker(mockProvider(DRAWDOWN), '0xabc');
    // The breaker's own try/catch swallows the mocked-exit throw — assert via spy
    await checkCircuitBreaker(mockProvider(DRAWDOWN), '0xabc');
    expect(isCircuitBroken()).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('resets the grace counter when the balance recovers', async () => {
    setInitialBalance(ONE_ETH);
    await checkCircuitBreaker(mockProvider(DRAWDOWN), '0xabc'); // breach 1
    await checkCircuitBreaker(mockProvider(DRAWDOWN), '0xabc'); // breach 2
    await checkCircuitBreaker(mockProvider(ONE_ETH),  '0xabc'); // recovered
    // Two fresh breaches must NOT halt — counter restarted
    await checkCircuitBreaker(mockProvider(DRAWDOWN), '0xabc');
    await checkCircuitBreaker(mockProvider(DRAWDOWN), '0xabc');
    expect(isCircuitBroken()).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('ignores drawdowns below the threshold', async () => {
    setInitialBalance(ONE_ETH);
    const smallDip = ethers.parseEther('0.8'); // 20% < 50% threshold
    await checkCircuitBreaker(mockProvider(smallDip), '0xabc');
    await checkCircuitBreaker(mockProvider(smallDip), '0xabc');
    await checkCircuitBreaker(mockProvider(smallDip), '0xabc');
    expect(isCircuitBroken()).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// ── Loss limits ────────────────────────────────────────────────────────────────

describe('lossLimits', () => {
  it('blocks trades above MAX_TRADE_USD', () => {
    const res = checkTradeAllowed(CONFIG.MAX_TRADE_USD + 1);
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain('MAX_TRADE_USD');
  });

  it('blocks trades whose estimated loss exceeds the per-trade cap', () => {
    const res = checkTradeAllowed(100, CONFIG.MAX_PER_TRADE_LOSS_USD + 1);
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain('MAX_PER_TRADE_LOSS_USD');
  });

  it('allows a normal trade within all limits', () => {
    const res = checkTradeAllowed(100, 1);
    expect(res.allowed).toBe(true);
  });

  it('accumulates recorded losses and blocks at the daily cap', () => {
    const before = getDailyLoss();
    recordLoss(CONFIG.MAX_DAILY_LOSS_USD - before); // hit the cap exactly
    const res = checkTradeAllowed(100, 1);
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain('MAX_DAILY_LOSS_USD');
  });

  it('resets the daily counter on the UTC day boundary', () => {
    expect(getDailyLoss()).toBeGreaterThan(0); // carried from previous test
    jest.useFakeTimers();
    try {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      jest.setSystemTime(tomorrow);
      expect(getDailyLoss()).toBe(0);
      expect(checkTradeAllowed(100, 1).allowed).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── Competition windows ────────────────────────────────────────────────────────

describe('clock competition windows', () => {
  afterEach(() => jest.useRealTimers());

  function atUtcHour(hour: number): void {
    jest.useFakeTimers();
    const d = new Date();
    d.setUTCHours(hour, 30, 0, 0);
    jest.setSystemTime(d);
  }

  it('us-market-open window (13–16 UTC) raises the threshold 1.5x', () => {
    atUtcHour(14);
    expect(getCompetitionWindow().label).toBe('us-market-open');
    expect(adjustedThreshold(10)).toBeCloseTo(15);
  });

  it('dead-hours window (4–7 UTC) lowers the threshold to 0.7x', () => {
    atUtcHour(5);
    expect(getCompetitionWindow().label).toBe('dead-hours');
    expect(adjustedThreshold(10)).toBeCloseTo(7);
  });

  it('uncovered hours fall back to 1.0x normal', () => {
    atUtcHour(20);
    expect(getCompetitionWindow().label).toBe('normal');
    expect(adjustedThreshold(10)).toBe(10);
  });
});
