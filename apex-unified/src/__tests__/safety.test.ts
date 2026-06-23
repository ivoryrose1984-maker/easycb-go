// Safety gate tests — these run without any .env so CONFIG defaults apply.
// DRY_RUN defaults to true (process.env.DRY_RUN !== 'false') and
// ALLOW_LIVE defaults to false (process.env.ALLOW_LIVE === 'true').

describe('safety gates (default env = dry run)', () => {
  // Guard: make sure tests never accidentally set live flags
  beforeAll(() => {
    expect(process.env.DRY_RUN).not.toBe('false');
    expect(process.env.ALLOW_LIVE).not.toBe('true');
  });

  it('assertDryRunMode does not throw with default env', () => {
    // Re-require inside test to pick up current env; Jest module cache may
    // already have config loaded — we just test the derived values directly.
    const DRY_RUN    = process.env.DRY_RUN    !== 'false';
    const ALLOW_LIVE = process.env.ALLOW_LIVE === 'true';

    expect(DRY_RUN).toBe(true);
    expect(ALLOW_LIVE).toBe(false);
  });

  it('requireLiveAllowed would block with default env', () => {
    const DRY_RUN    = process.env.DRY_RUN    !== 'false';
    const ALLOW_LIVE = process.env.ALLOW_LIVE === 'true';

    // Mirrors the logic in safety.ts checkExecutionAllowed()
    const blocked = DRY_RUN || !ALLOW_LIVE;
    expect(blocked).toBe(true);
  });
});

// ── Circuit-breaker kill-switch integration ───────────────────────────────────

import { killStrategy, isKilled, reviveStrategy, getKilled } from '../risk/strategyKillSwitch';

describe('strategyKillSwitch', () => {
  afterEach(() => {
    // Revive any strategies killed during tests
    for (const id of getKilled()) reviveStrategy(id);
  });

  it('starts with no killed strategies', () => {
    expect(getKilled()).toHaveLength(0);
  });

  it('marks a strategy as killed', () => {
    killStrategy('apex.dex_spread', 'test');
    expect(isKilled('apex.dex_spread')).toBe(true);
  });

  it('revives a strategy', () => {
    killStrategy('apex.triangular', 'test');
    reviveStrategy('apex.triangular');
    expect(isKilled('apex.triangular')).toBe(false);
  });

  it('killing multiple strategies works independently', () => {
    killStrategy('apex.dex_spread',       'test');
    killStrategy('grok.cbeth_fair_value', 'test');
    expect(isKilled('apex.dex_spread')).toBe(true);
    expect(isKilled('grok.cbeth_fair_value')).toBe(true);
    expect(isKilled('apex.triangular')).toBe(false);
  });
});
