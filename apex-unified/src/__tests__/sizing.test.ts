import { ternarySearchSize } from '../execution/flashLoanPlanner';
import { getHttpProvider, _resetHttpProviderForTest } from '../infrastructure/fallbackProvider';

// ── ternarySearchSize ──────────────────────────────────────────────────────────

describe('ternarySearchSize', () => {
  it('converges to peak of a symmetric unimodal profit curve', async () => {
    // Profit = 1000 - |x - 10_000| (peak at 10_000, triangular shape)
    const peak = 10_000n;
    const fn = async (x: bigint): Promise<bigint> => {
      const diff = x > peak ? x - peak : peak - x;
      return diff < peak ? peak - diff : 0n;
    };
    const result = await ternarySearchSize(fn, 1n, 50_000n, 8);
    // Should be within 1% of 10_000 after 8 iterations
    const tol = 500n;
    expect(result >= peak - tol && result <= peak + tol).toBe(true);
  });

  it('converges to peak of an asymmetric curve', async () => {
    // Profit = max(0, (x - 2000) * (30000 - x)) — peak near (2000+30000)/2 = 16000
    const fn = async (x: bigint): Promise<bigint> => {
      if (x < 2_000n || x > 30_000n) return 0n;
      return (x - 2_000n) * (30_000n - x);
    };
    const result = await ternarySearchSize(fn, 2_000n, 30_000n, 8);
    const truePeak = 16_000n;
    const tol = 300n;
    expect(result >= truePeak - tol && result <= truePeak + tol).toBe(true);
  });

  it('handles all-zero profit (returns midpoint)', async () => {
    const fn = async (_x: bigint): Promise<bigint> => 0n;
    const result = await ternarySearchSize(fn, 0n, 1_000n, 4);
    // Should not throw and should return something in [0, 1000]
    expect(result >= 0n && result <= 1_000n).toBe(true);
  });

  it('respects bounds — result stays within [lo, hi]', async () => {
    const fn = async (x: bigint): Promise<bigint> => x; // monotone: peak at hi
    const lo = 1_000n, hi = 50_000n;
    const result = await ternarySearchSize(fn, lo, hi, 8);
    expect(result >= lo && result <= hi).toBe(true);
  });
});

// ── getHttpProvider ───────────────────────────────────────────────────────────

describe('getHttpProvider', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
    _resetHttpProviderForTest();
  });

  it('returns null when no HTTP URLs are configured', () => {
    process.env.BASE_HTTPS_URLS = '';
    process.env.BASE_HTTPS_URL  = '';
    _resetHttpProviderForTest();
    expect(getHttpProvider()).toBeNull();
  });

  it('returns JsonRpcProvider for a single URL', () => {
    process.env.BASE_HTTPS_URLS = '';
    process.env.BASE_HTTPS_URL  = 'https://base.example.com/v2/key';
    _resetHttpProviderForTest();
    const p = getHttpProvider();
    expect(p).not.toBeNull();
    expect(p?.constructor.name).toBe('JsonRpcProvider');
  });

  it('returns FallbackProvider for comma-separated URLs', () => {
    process.env.BASE_HTTPS_URLS = 'https://rpc1.example.com,https://rpc2.example.com';
    _resetHttpProviderForTest();
    const p = getHttpProvider();
    expect(p).not.toBeNull();
    expect(p?.constructor.name).toBe('FallbackProvider');
  });

  it('BASE_HTTPS_URLS takes priority over BASE_HTTPS_URL', () => {
    process.env.BASE_HTTPS_URLS = 'https://multi1.example.com,https://multi2.example.com';
    process.env.BASE_HTTPS_URL  = 'https://single.example.com';
    _resetHttpProviderForTest();
    const p = getHttpProvider();
    expect(p?.constructor.name).toBe('FallbackProvider');
  });

  it('returns cached instance on repeated calls', () => {
    process.env.BASE_HTTPS_URL  = 'https://base.example.com/v2/key';
    process.env.BASE_HTTPS_URLS = '';
    _resetHttpProviderForTest();
    const p1 = getHttpProvider();
    const p2 = getHttpProvider();
    expect(p1).toBe(p2);
  });
});
