import * as fs   from 'fs';
import * as path from 'path';

// D1: all writes are fire-and-forget via in-memory buffer + async appendFile.
// captureDetected/captureSubmitted/captureResolved return synchronously in <1µs.
//
// D2: expected_net_usd comes from opp.netProfitUsd which is set by each signal.
// Full consolidation onto calculateNetProfit() (flashLoanPlanner) is a follow-on
// task; do not add a second profit-math path here.

const LOG_DIR = path.resolve(process.cwd(), 'logs');

export type FilterResult = 'pass' | 'skip';
export type Outcome = 'LANDED_PROFIT' | 'LANDED_LOSS' | 'REVERTED' | 'NOT_INCLUDED' | 'ERROR';

// ── Event parameter shapes ────────────────────────────────────────────────────

export interface DetectParams {
  opportunityId: string;
  strategyId:    string;
  block:         number;
  path:          string;
  spreadBps:     number;
  grossUsd:      number;
  netUsd:        number;
  loanSize:      string;
  filterResult:  FilterResult;
  skipReason:    string | null;
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
  strategyId:           string;
  detected:             number;
  passed:               number;
  submitted:            number;
  resolved:             number;
  landedProfit:         number;
  submissionRate:       number;   // submitted / passed (n/a = 0 in dry-run)
  inclusionRate:        number;   // resolved-landed / submitted
  winRate:              number;   // LANDED_PROFIT / resolved-landed
  captureRate:          number;   // LANDED_PROFIT / detected
  avgProfitDelta:       number | null;  // avg (actual_net - expected_net); null in dry-run
  avgDetectToIncBlocks: number | null;  // null in dry-run
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

export function readCaptureStats(dates: string[]): CaptureStats[] {
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
    const passed       = b.detected.filter(e => e.filter_result === 'pass').length;
    const sub          = b.submitted.length;
    const landed       = b.resolved.filter(e => e.outcome === 'LANDED_PROFIT' || e.outcome === 'LANDED_LOSS').length;
    const landedProfit = b.resolved.filter(e => e.outcome === 'LANDED_PROFIT').length;

    const deltas     = b.resolved.map(e => e.expected_vs_actual_delta).filter((v): v is number => v !== null);
    const blkTimes   = b.resolved.map(e => e.blocks_elapsed).filter((v): v is number => v !== null);

    stats.push({
      strategyId:           sid,
      detected:             b.detected.length,
      passed,
      submitted:            sub,
      resolved:             b.resolved.length,
      landedProfit,
      submissionRate:       passed > 0   ? sub          / passed : 0,
      inclusionRate:        sub    > 0   ? landed        / sub    : 0,
      winRate:              landed > 0   ? landedProfit  / landed : 0,
      captureRate:          b.detected.length > 0 ? landedProfit / b.detected.length : 0,
      avgProfitDelta:       deltas.length   > 0 ? deltas.reduce((a, b) => a + b, 0)   / deltas.length   : null,
      avgDetectToIncBlocks: blkTimes.length > 0 ? blkTimes.reduce((a, b) => a + b, 0) / blkTimes.length : null,
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
