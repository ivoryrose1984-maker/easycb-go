import {
  captureDetected,
  captureSubmitted,
  captureResolved,
  readCaptureStats,
  _getBufferForTest,
  _clearBufferForTest,
  _resetAllForTest,
  DetectParams,
} from '../core/captureTelemetry';

// captureTelemetry uses fs.appendFile (async, non-blocking).
// Tests verify buffer state synchronously — no real I/O needed.
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(() => false),
  mkdirSync:  jest.fn(),
  appendFile: jest.fn((_p: any, _d: any, _e: any, cb: Function) => cb(null)),
}));

const BASE_DETECT: DetectParams = {
  opportunityId: 'test-opp-001',
  strategyId:    'apex.dex_spread',
  block:         47_000_000,
  path:          'USDC→WETH→USDC',
  spreadBps:     25,
  grossUsd:      12.5,
  netUsd:        8.2,
  loanSize:      '5000000000',
  filterResult:  'pass',
  skipReason:    null,
};

beforeEach(() => _resetAllForTest());

// ── Hot-path timing ───────────────────────────────────────────────────────────

describe('captureDetected timing — hot-path compliance (D1)', () => {
  it('p99 of 10,000 calls < 5ms', () => {
    const times: number[] = [];
    for (let i = 0; i < 10_000; i++) {
      const t0 = performance.now();
      captureDetected({ ...BASE_DETECT, opportunityId: `hash-${i}` });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p99 = times[Math.floor(times.length * 0.99)];
    expect(p99).toBeLessThan(5);
  });
});

// ── Detected event ────────────────────────────────────────────────────────────

describe('captureDetected', () => {
  it('pushes a detected record to the buffer', () => {
    captureDetected(BASE_DETECT);
    const buf = _getBufferForTest();
    expect(buf).toHaveLength(1);
    const rec = JSON.parse(buf[0]);
    expect(rec.event).toBe('detected');
    expect(rec.opportunityId).toBe('test-opp-001');
    expect(rec.strategyId).toBe('apex.dex_spread');
    expect(rec.filter_result).toBe('pass');
    expect(rec.skip_reason).toBeNull();
    expect(rec.spread_bps).toBe(25);
  });

  it('records skipReason for filtered opportunities', () => {
    captureDetected({ ...BASE_DETECT, opportunityId: 'skip-001', filterResult: 'skip', skipReason: 'thin_pool: 10x_impact=8000bps' });
    const rec = JSON.parse(_getBufferForTest()[0]);
    expect(rec.filter_result).toBe('skip');
    expect(rec.skip_reason).toBe('thin_pool: 10x_impact=8000bps');
  });

  it('records dedup_ttl skip reason', () => {
    captureDetected({ ...BASE_DETECT, opportunityId: 'dup-001', filterResult: 'skip', skipReason: 'dedup_ttl' });
    const rec = JSON.parse(_getBufferForTest()[0]);
    expect(rec.skip_reason).toBe('dedup_ttl');
  });
});

// ── NOT_INCLUDED resolution ───────────────────────────────────────────────────

describe('captureResolved — NOT_INCLUDED', () => {
  it('writes a NOT_INCLUDED record and cleans up tracking state', () => {
    captureDetected({ ...BASE_DETECT, opportunityId: 'not-inc-001' });
    _clearBufferForTest(); // buffer only — tracking maps stay

    captureResolved({
      opportunityId:  'not-inc-001',
      outcome:        'NOT_INCLUDED',
      inclusionBlock: null,
      blocksElapsed:  null,
      actualGrossUsd: null,
      actualNetUsd:   null,
    });

    const buf = _getBufferForTest();
    expect(buf).toHaveLength(1);
    const rec = JSON.parse(buf[0]);
    expect(rec.event).toBe('resolved');
    expect(rec.outcome).toBe('NOT_INCLUDED');
    expect(rec.inclusion_block).toBeNull();
    expect(rec.actual_net_usd).toBeNull();
  });

  it('computes expected_vs_actual_delta for LANDED_PROFIT', () => {
    captureDetected({ ...BASE_DETECT, opportunityId: 'landed-001', netUsd: 10.0 });
    _clearBufferForTest(); // clears buffer only — leaves expectedNet map intact

    captureResolved({
      opportunityId:  'landed-001',
      outcome:        'LANDED_PROFIT',
      inclusionBlock: 47_000_001,
      blocksElapsed:  1,
      actualGrossUsd: 14.0,
      actualNetUsd:   9.0,
    });

    const rec = JSON.parse(_getBufferForTest()[0]);
    expect(rec.outcome).toBe('LANDED_PROFIT');
    expect(rec.expected_vs_actual_delta).toBeCloseTo(-1.0);  // 9.0 - 10.0
    expect(rec.blocks_elapsed).toBe(1);
  });

  it('sets delta to null when no prior detect record exists', () => {
    captureResolved({
      opportunityId:  'orphan-001',
      outcome:        'ERROR',
      inclusionBlock: null,
      blocksElapsed:  null,
      actualGrossUsd: null,
      actualNetUsd:   null,
    });
    const rec = JSON.parse(_getBufferForTest()[0]);
    expect(rec.expected_vs_actual_delta).toBeNull();
  });
});

// ── Submitted event ───────────────────────────────────────────────────────────

describe('captureSubmitted', () => {
  it('records detect_to_submit_ms', () => {
    captureDetected({ ...BASE_DETECT, opportunityId: 'submit-001' });
    _clearBufferForTest(); // buffer only — detectTs map stays

    captureSubmitted({ opportunityId: 'submit-001', txHash: '0xabc', gasPrice: '1000000000', priorityFee: '500000', nonce: 42 });
    const rec = JSON.parse(_getBufferForTest()[0]);
    expect(rec.event).toBe('submitted');
    expect(rec.tx_hash).toBe('0xabc');
    expect(rec.nonce).toBe(42);
    expect(typeof rec.detect_to_submit_ms).toBe('number');
    expect(rec.detect_to_submit_ms).toBeGreaterThanOrEqual(0);
  });
});

// ── readCaptureStats ──────────────────────────────────────────────────────────

describe('readCaptureStats', () => {
  it('returns empty array when no capture files exist', () => {
    const stats = readCaptureStats(['2099-01-01']);
    expect(stats).toEqual([]);
  });

  it('returns n/a (null) for live-only fields in dry-run (no submitted/resolved events)', () => {
    // In dry-run there are detected events but no submitted/resolved
    const stats = readCaptureStats(['2099-01-01']);
    for (const s of stats) {
      expect(s.avgProfitDelta).toBeNull();
      expect(s.avgDetectToIncBlocks).toBeNull();
    }
  });
});

// ── readCaptureStats sinceMs filter (WO-3 CLEAN_DATA_SINCE) ──────────────────

describe('readCaptureStats — sinceMs filter', () => {
  const OLD_TS = 1_000_000;
  const NEW_TS = 2_000_000;
  const SINCE  = 1_500_000;

  const fakeLine = (ts: number, filterResult: 'pass' | 'skip', spreadBps = 30) =>
    JSON.stringify({
      event:              'detected',
      opportunityId:      `opp-${ts}-${filterResult}`,
      strategyId:         'apex.dex_spread',
      block:              1,
      ts_ms:              ts,
      path:               'USDC/WETH',
      spread_bps:         spreadBps,
      expected_gross_usd: 10,
      expected_net_usd:   8,
      loan_size:          '5000000000',
      filter_result:      filterResult,
      skip_reason:        filterResult === 'skip' ? 'below_threshold' : null,
    });

  const FAKE_CONTENT = [
    fakeLine(OLD_TS, 'pass'),
    fakeLine(NEW_TS, 'pass'),
    fakeLine(OLD_TS, 'skip'),
    fakeLine(NEW_TS, 'skip'),
  ].join('\n');

  beforeEach(() => {
    const fs = require('fs') as typeof import('fs');
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    (jest.spyOn(fs, 'readFileSync') as jest.SpyInstance).mockReturnValue(FAKE_CONTENT);
  });

  afterEach(() => jest.restoreAllMocks());

  it('without sinceMs includes all 4 events', () => {
    const stats = readCaptureStats(['2026-06-12']);
    expect(stats).toHaveLength(1);
    expect(stats[0].detected).toBe(4);
    expect(stats[0].passed).toBe(2);
    expect(stats[0].skipped).toBe(2);
  });

  it('with sinceMs excludes the 2 events before the threshold', () => {
    const stats = readCaptureStats(['2026-06-12'], SINCE);
    expect(stats).toHaveLength(1);
    expect(stats[0].detected).toBe(2);
    expect(stats[0].passed).toBe(1);
    expect(stats[0].skipped).toBe(1);
  });

  it('excludes pre-window events from P&L figures', () => {
    const stats = readCaptureStats(['2026-06-12'], SINCE);
    expect(stats[0].grossEstimatedProfitUsd).toBeCloseTo(10);
    expect(stats[0].netEstimatedProfitUsd).toBeCloseTo(8);
  });

  it('excludes pre-window skips from skipReasonBreakdown', () => {
    const stats = readCaptureStats(['2026-06-12'], SINCE);
    expect(stats[0].skipReasonBreakdown['below_threshold']).toBe(1);
  });

  it('sinceMs equal to event ts_ms includes that event (filter is strict <)', () => {
    const stats = readCaptureStats(['2026-06-12'], NEW_TS);
    expect(stats[0].detected).toBe(2);
  });
});

// ── anomaly filter_result (Phase 1 / BUG-01) ─────────────────────────────────

describe('readCaptureStats — anomaly accounting', () => {
  const TS = 1_000_000;

  const line = (filterResult: 'pass' | 'skip' | 'anomaly') => JSON.stringify({
    event: 'detected', opportunityId: `opp-${filterResult}`, strategyId: 'apex.dex_spread',
    block: 1, ts_ms: TS, path: 'USDC/WETH', spread_bps: filterResult === 'anomaly' ? -9577 : 30,
    expected_gross_usd: 10, expected_net_usd: 8, loan_size: '5000000000',
    filter_result: filterResult, skip_reason: filterResult === 'skip' ? 'thin_pool' : null,
  });

  const CONTENT = [line('pass'), line('skip'), line('anomaly')].join('\n');

  beforeEach(() => {
    const fs = require('fs') as typeof import('fs');
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    (jest.spyOn(fs, 'readFileSync') as jest.SpyInstance).mockReturnValue(CONTENT);
  });

  afterEach(() => jest.restoreAllMocks());

  it('anomaly is counted separately from skip', () => {
    const [s] = readCaptureStats(['2026-06-12']);
    expect(s.detected).toBe(3);
    expect(s.passed).toBe(1);
    expect(s.skipped).toBe(1);
    expect(s.anomalies).toBe(1);
  });

  it('anomaly is not in skipReasonBreakdown', () => {
    const [s] = readCaptureStats(['2026-06-12']);
    const keys = Object.keys(s.skipReasonBreakdown);
    expect(keys).not.toContain('unit_anomaly');
    expect(keys).toContain('thin_pool');
  });

  it('anomaly does not contribute to P&L figures', () => {
    const [s] = readCaptureStats(['2026-06-12']);
    // Only the 1 pass event contributes to gross/net
    expect(s.grossEstimatedProfitUsd).toBeCloseTo(10);
  });
});
