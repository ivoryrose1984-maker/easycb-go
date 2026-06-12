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
