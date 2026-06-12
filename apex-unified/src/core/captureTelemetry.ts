import * as fs   from 'fs';
import * as path from 'path';

// D1: all writes are fire-and-forget via in-memory buffer + async appendFile.
// captureDetected/captureSubmitted/captureResolved return synchronously in <1µs.
//
// D2: expected_net_usd comes from opp.netProfitUsd which is set by each signal.
// Full consolidation onto calculateNetProfit() (flashLoanPlanner) is a follow-on
// task; do not add a second profit-math path here.

const LOG_DIR = path.resolve(process.cwd(), 'logs');

// 'anomaly' = |spread| > 2000bps (unit error or empty pool) — excluded from skip stats
export type FilterResult = 'pass' | 'skip' | 'anomaly';
export type Outcome = 'LANDED_PROFIT' | 'LANDED_LOSS' | 'REVERTED' | 'NOT_INCLUDED' | 'ERROR';

// ── Event parameter shapes ────────────────────────────────────────────────────

export interface DetectParams {
  opportunityId:  string;
  strategyId:     string;
  block:          number;
  path:           string;
  spreadBps:      number;
  grossUsd:       number;
  netUsd:         number;
  loanSize:       string;
  filterResult:   FilterResult;
  skipReason:     string | null;
  // Size-search bounds (dex_spread only; absent for fixed-size strategies)
  chosenSizeLo?:  string;
  chosenSizeHi?:  string;
}

export interface SubmitParams {
  opportunityId: string;
  txHash:        string;
  gasPrice:      string;
  priorityFee:   string;
  nonce:         number;
}

export interface ResolveParams {
  opportunityId:  string;
  outcome:        Outcome;
  inclusionBlock: number | null;
  blocksElapsed:  number | null;
  actualGrossUsd: number | null;
  actualNetUsd:   number | null;
}

export interface CaptureStats {
  strategyId:              string;
  detected:                number;  // pass + skip + anomaly
  passed:                  number;
  skipped:                 number;  // intentional filters (thin pool, below threshold, dedup)
  anomalies:               number;  // |spread| > 2000bps — excluded from skip stats
  submitted:               number;
  resolved:                number;
  landedProfit:            number;
  submissionRate:          number;   // submitted / passed (n/a = 0 in dry-run)
  inclusionRate:           number;   // resolved-landed / submitted
  winRate:                 number;   // LANDED_PROFIT / resolved-landed
  captureRate:             number;   // LANDED_PROFIT / detected
  avgProfitDelta:          number | null;  // avg (actual_net - expected_net); null in dry-run
  avgDetectToIncBlocks:    number | null;  // null in dry-run
  // D2 single-source P&L fields (from pass events only)
  grossEstimatedProfitUsd: number;
  netEstimatedProfitUsd:   number;
  medianSpreadBps:         number;
  skipReasonBreakdown:     Record<string, number>;
}

// ── Module-level state ────────────────────────────────────────────────────────

// For detect_to_submit_ms and expected_vs_actual_delta
const detectTs:    Map<string, number> = new Map();
const expectedNet: Map<string, number> = new Map();

const writeBuffer: string[] = [];
let   draining = false;

function captureFile(): string {
  return path.join(LOG_DIR, `capture-${new Date().toISOString().slice(0, 10)}.jsonl`);
}

function scheduleDrain(): void {
  if (draining) return;
  draining = true;
  setImmediate(drain);
}

function drain(): void {
  if (writeBuffer.length === 0) { draining = false; return; }
  const batch = writeBuffer.splice(0, writeBuffer.length).join('\n') + '\n';
  try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  fs.appendFile(captureFile(), batch, 'utf8', (err) => {
    if (err) console.error('[CAPTURE] Write failed:', err.message);
    draining = false;
    if (writeBuffer.length > 0) { draining = true; setImmediate(drain); }
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export function captureDetected(p: DetectParams): void {
  const ts = Date.now();
  detectTs.set(p.opportunityId, ts);
  if (p.filterResult === 'pass') expectedNet.set(p.opportunityId, p.netUsd);
  writeBuffer.push(JSON.stringify({
    event:              'detected',
    opportunityId:      p.opportunityId,
    strategyId:         p.strategyId,
    block:              p.block,
    ts_ms:              ts,
    path:               p.path,
    spread_bps:         p.spreadBps,
    expected_gross_usd: p.grossUsd,
    expected_net_usd:   p.netUsd,
    loan_size:          p.loanSize,
    filter_result:      p.filterResult,
    skip_reason:        p.skipReason,
    ...(p.chosenSizeLo !== undefined && { chosen_size_lo: p.chosenSizeLo }),
    ...(p.chosenSizeHi !== undefined && { chosen_size_hi: p.chosenSizeHi }),
  }));
  scheduleDrain();
}

export function captureSubmitted(p: SubmitParams): void {
  const ts       = Date.now();
  const detectAt = detectTs.get(p.opportunityId) ?? ts;
  writeBuffer.push(JSON.stringify({
    event:               'submitted',
    opportunityId:       p.opportunityId,
    tx_hash:             p.txHash,
    ts_ms:               ts,
    detect_to_submit_ms: ts - detectAt,
    gas_price:           p.gasPrice,
    priority_fee:        p.priorityFee,
    nonce:               p.nonce,
  }));
  scheduleDrain();
}

export function captureResolved(p: ResolveParams): void {
  const expNet = expectedNet.get(p.opportunityId) ?? null;
  const delta  = p.actualNetUsd !== null && expNet !== null ? p.actualNetUsd - expNet : null;
  writeBuffer.push(JSON.stringify({
    event:                    'resolved',
    opportunityId:            p.opportunityId,
    outcome:                  p.outcome,
    ts_ms:                    Date.now(),
    inclusion_block:          p.inclusionBlock,
    blocks_elapsed:           p.blocksElapsed,
    actual_gross_usd:         p.actualGrossUsd,
    actual_net_usd:           p.actualNetUsd,
    expected_vs_actual_delta: delta,
  }));
  detectTs.delete(p.opportunityId);
  expectedNet.delete(p.opportunityId);
  scheduleDrain();
}

// ── Report helper ─────────────────────────────────────────────────────────────

// sinceMs: exclude all events with ts_ms < sinceMs (CLEAN_DATA_SINCE gate).
export function readCaptureStats(dates: string[], sinceMs = 0): CaptureStats[] {
  // All three event types share the same file. Join by opportunityId to bucket
  // submitted/resolved under the strategy of their detected event.
  const detected:  any[] = [];
  const submitted: any[] = [];
  const resolved:  any[] = [];

  for (const d of dates) {
    const f = path.join(LOG_DIR, `capture-${d}.jsonl`);
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      try {
        const e = JSON.parse(line);
        if (sinceMs > 0 && (e.ts_ms ?? 0) < sinceMs) continue;
        if      (e.event === 'detected')  detected.push(e);
        else if (e.event === 'submitted') submitted.push(e);
        else if (e.event === 'resolved')  resolved.push(e);
      } catch {}
    }
  }

  // Build oppId → strategyId map from detected events
  const oppStrategy = new Map<string, string>();
  for (const e of detected) oppStrategy.set(e.opportunityId, e.strategyId);

  // Group all events by strategyId
  type Bucket = { detected: any[]; submitted: any[]; resolved: any[] };
  const byStrategy = new Map<string, Bucket>();

  const ensureBucket = (sid: string): Bucket => {
    if (!byStrategy.has(sid)) byStrategy.set(sid, { detected: [], submitted: [], resolved: [] });
    return byStrategy.get(sid)!;
  };

  for (const e of detected)  ensureBucket(e.strategyId).detected.push(e);
  for (const e of submitted) ensureBucket(oppStrategy.get(e.opportunityId) ?? 'unknown').submitted.push(e);
  for (const e of resolved)  ensureBucket(oppStrategy.get(e.opportunityId) ?? 'unknown').resolved.push(e);

  const stats: CaptureStats[] = [];
  for (const [sid, b] of byStrategy) {
    const passEvents     = b.detected.filter(e => e.filter_result === 'pass');
    const passed         = passEvents.length;
    const anomalies      = b.detected.filter(e => e.filter_result === 'anomaly').length;
    const skipped        = b.detected.length - passed - anomalies;
    const sub            = b.submitted.length;
    const landed         = b.resolved.filter(e => e.outcome === 'LANDED_PROFIT' || e.outcome === 'LANDED_LOSS').length;
    const landedProfit   = b.resolved.filter(e => e.outcome === 'LANDED_PROFIT').length;

    const deltas   = b.resolved.map(e => e.expected_vs_actual_delta).filter((v): v is number => v !== null);
    const blkTimes = b.resolved.map(e => e.blocks_elapsed).filter((v): v is number => v !== null);

    // P&L chain (D2): signal.netProfitUsd → scanner captureDetected(netUsd) →
    // written as expected_net_usd → summed here from pass events only.
    const grossTotal = passEvents.reduce((s, e) => s + (e.expected_gross_usd ?? 0), 0);
    const netTotal   = passEvents.reduce((s, e) => s + (e.expected_net_usd   ?? 0), 0);
    const bpsArr     = passEvents.map(e => e.spread_bps as number).sort((a, c) => a - c);
    // floor(n/2) gives the true median for odd n and the upper-middle element for
    // even n — a 1-element difference for integer bps values, acceptable for reporting.
    const median     = bpsArr.length > 0 ? bpsArr[Math.floor(bpsArr.length / 2)] : 0;

    // skip breakdown excludes anomalies — anomaly events are unit errors, not intentional filters
    const skipBreakdown: Record<string, number> = {};
    for (const e of b.detected.filter(e => e.filter_result === 'skip')) {
      const key = e.skip_reason ?? 'unknown';
      skipBreakdown[key] = (skipBreakdown[key] ?? 0) + 1;
    }

    stats.push({
      strategyId:              sid,
      detected:                b.detected.length,
      passed,
      skipped,
      anomalies,
      submitted:               sub,
      resolved:                b.resolved.length,
      landedProfit,
      submissionRate:          passed > 0 ? sub          / passed : 0,
      inclusionRate:           sub    > 0 ? landed        / sub    : 0,
      winRate:                 landed > 0 ? landedProfit  / landed : 0,
      captureRate:             b.detected.length > 0 ? landedProfit / b.detected.length : 0,
      avgProfitDelta:          deltas.length   > 0 ? deltas.reduce((a, c) => a + c, 0)   / deltas.length   : null,
      avgDetectToIncBlocks:    blkTimes.length > 0 ? blkTimes.reduce((a, c) => a + c, 0) / blkTimes.length : null,
      grossEstimatedProfitUsd: grossTotal,
      netEstimatedProfitUsd:   netTotal,
      medianSpreadBps:         median,
      skipReasonBreakdown:     skipBreakdown,
    });
  }

  return stats.sort((a, b) => b.detected - a.detected);
}

// ── Test helpers (not for production use) ────────────────────────────────────

export function _getBufferForTest(): readonly string[] { return writeBuffer; }
// Clears only the write buffer — tracking maps (detectTs, expectedNet) are preserved.
// Call _resetAllForTest() in beforeEach for full isolation.
export function _clearBufferForTest(): void { writeBuffer.length = 0; }
export function _resetAllForTest(): void { writeBuffer.length = 0; detectTs.clear(); expectedNet.clear(); }
