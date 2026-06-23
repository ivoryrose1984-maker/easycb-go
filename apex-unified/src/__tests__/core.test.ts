import { opportunityHash, isNewOpportunity, clearDedup } from '../core/dedup';
import { uptime }                                        from '../core/runContext';
import { adjustedThreshold }                            from '../core/clock';

// ── dedup ─────────────────────────────────────────────────────────────────────

const BASE_FIELDS = {
  chainId:      8453,
  strategyId:   'apex.dex_spread',
  feeTier:      500,
  tokenIn:      '0xAAAA',
  tokenOut:     '0xBBBB',
  quotedInput:  '1000000',
  quotedOutput: '1001000',
};

describe('opportunityHash', () => {
  it('returns a 16-char hex string', () => {
    const h = opportunityHash(BASE_FIELDS);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic', () => {
    expect(opportunityHash(BASE_FIELDS)).toBe(opportunityHash(BASE_FIELDS));
  });

  it('differs when any field changes', () => {
    const h1 = opportunityHash(BASE_FIELDS);
    const h2 = opportunityHash({ ...BASE_FIELDS, feeTier: 3000 });
    expect(h1).not.toBe(h2);
  });

  it('normalises tokenIn/tokenOut to lowercase', () => {
    const upper = opportunityHash({ ...BASE_FIELDS, tokenIn: '0xAAAA' });
    const lower = opportunityHash({ ...BASE_FIELDS, tokenIn: '0xaaaa' });
    expect(upper).toBe(lower);
  });
});

describe('isNewOpportunity', () => {
  beforeEach(() => clearDedup());

  it('returns true for a new hash', () => {
    expect(isNewOpportunity('abc123', 100)).toBe(true);
  });

  it('returns false for the same hash in the next block (within TTL)', () => {
    isNewOpportunity('abc123', 100);
    expect(isNewOpportunity('abc123', 101)).toBe(false);
  });

  it('returns false for same hash 2 blocks later (still within TTL=3)', () => {
    isNewOpportunity('abc123', 100);
    expect(isNewOpportunity('abc123', 102)).toBe(false);
  });

  it('returns true again once TTL expires (block gap >= 3)', () => {
    isNewOpportunity('abc123', 100);
    expect(isNewOpportunity('abc123', 103)).toBe(true);
  });

  it('returns true again after clear', () => {
    isNewOpportunity('abc123', 100);
    clearDedup();
    expect(isNewOpportunity('abc123', 101)).toBe(true);
  });
});

// ── uptime ────────────────────────────────────────────────────────────────────

describe('uptime', () => {
  it('formats zero seconds as 0h0m0s', () => {
    const now = Date.now();
    expect(uptime(now)).toBe('0h0m0s');
  });

  it('formats 3661 seconds correctly', () => {
    const start = Date.now() - 3_661_000;
    expect(uptime(start)).toBe('1h1m1s');
  });
});

// ── adjustedThreshold ─────────────────────────────────────────────────────────

describe('adjustedThreshold', () => {
  it('returns a positive number', () => {
    expect(adjustedThreshold(5)).toBeGreaterThan(0);
  });

  it('scales the base threshold by window multiplier (≥ 0.7×)', () => {
    // Multiplier is between 0.7 and 1.5 — result must be in that range
    const result = adjustedThreshold(10);
    expect(result).toBeGreaterThanOrEqual(7);
    expect(result).toBeLessThanOrEqual(15);
  });
});
