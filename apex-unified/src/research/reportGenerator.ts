import { StrategyId }      from '../types/Opportunity';
import { RunReport, StrategyStats } from '../types/RunReport';
import { readCaptureStats, CaptureStats } from '../core/captureTelemetry';
import CONFIG               from '../core/config';
import { getRunContext }    from '../core/runContext';
import * as fs              from 'fs';
import * as path            from 'path';

const STRATEGY_IDS: StrategyId[] = [
  'apex.dex_spread', 'apex.triangular', 'grok.cbeth_fair_value', 'apex.aerodrome_spread',
];

function zeroStats(strategyId: StrategyId): StrategyStats {
  return {
    strategyId,
    totalScans:              0,
    totalOpportunities:      0,
    acceptedOpportunities:   0,
    rejectedOpportunities:   0,
    rejectionBreakdown:      {},
    grossEstimatedProfitUsd: 0,
    netEstimatedProfitUsd:   0,
    avgGasCostEth:           0.0003,
    avgSlippageBps:          0,
    medianOpportunityBps:    0,
    falsePositiveRate:       0,
    expectedValueUsd:        0,
  };
}

// D2: single source of truth — derive StrategyStats exclusively from capture-*.jsonl
function buildStatsFromCapture(strategyId: StrategyId, captureArr: CaptureStats[]): StrategyStats {
  const c = captureArr.find(s => s.strategyId === strategyId);
  if (!c) return zeroStats(strategyId);
  return {
    strategyId,
    totalScans:              c.detected,
    totalOpportunities:      c.passed,
    acceptedOpportunities:   c.passed,
    rejectedOpportunities:   c.skipped,
    rejectionBreakdown:      c.skipReasonBreakdown,
    grossEstimatedProfitUsd: c.grossEstimatedProfitUsd,
    netEstimatedProfitUsd:   c.netEstimatedProfitUsd,
    avgGasCostEth:           0.0003,
    avgSlippageBps:          0,
    medianOpportunityBps:    c.medianSpreadBps,
    falsePositiveRate:       c.detected > 0 ? c.skipped / c.detected : 0,
    expectedValueUsd:        c.netEstimatedProfitUsd,
  };
}

function liveReadinessScore(stats: StrategyStats[]): { score: number; blockers: string[] } {
  const blockers: string[] = [];
  let score = 0;

  const best = stats.find(s => s.acceptedOpportunities > 0);
  if (!best) {
    blockers.push('No accepted opportunities during dry run — no edge confirmed');
    return { score: 0, blockers };
  }

  if (best.acceptedOpportunities >= 10) score += 30;
  else blockers.push(`Too few opportunities (${best.acceptedOpportunities}) — need ≥10`);

  if (best.falsePositiveRate < 0.3) score += 20;
  else blockers.push(`High skip rate ${(best.falsePositiveRate * 100).toFixed(0)}% — need <30%`);

  if (best.netEstimatedProfitUsd > 0) score += 20;
  else blockers.push('Negative net profit — costs exceed edge');

  if (!CONFIG.CONTRACTS.APEX_FLASH_LOAN.startsWith('0x000')) score += 15;
  else blockers.push('Flash loan contract not deployed');

  if (process.env.WALLET_PRIVATE_KEY) score += 10;
  else blockers.push('WALLET_PRIVATE_KEY not set — required for live signing');

  if (CONFIG.ENABLE_BUILDER_SUBMISSION) score += 5;
  else blockers.push('ENABLE_BUILDER_SUBMISSION=false — enable for live execution');

  return { score, blockers };
}

export async function generate72HourReport(): Promise<RunReport> {
  const ctx     = getRunContext();
  const now     = Date.now();
  const sinceMs = new Date(CONFIG.CLEAN_DATA_SINCE).getTime();

  const dates = Array.from({ length: 3 }, (_, i) =>
    new Date(now - i * 86_400_000).toISOString().slice(0, 10)
  );

  // D2: capture-*.jsonl is the single source of truth for all P&L and scan figures
  const captureStats = readCaptureStats(dates, sinceMs);
  const stats        = STRATEGY_IDS.map(id => buildStatsFromCapture(id, captureStats));

  const byEV = [...stats].sort((a, b) => b.expectedValueUsd - a.expectedValueUsd);
  const byFP = [...stats].sort((a, b) => a.falsePositiveRate - b.falsePositiveRate);

  const { score, blockers } = liveReadinessScore(stats);

  const best  = byEV[0]?.expectedValueUsd  > 0              ? byEV[0].strategyId  : null;
  const worst = byFP[byFP.length - 1]?.totalOpportunities > 0 ? byFP[byFP.length - 1].strategyId : null;

  const totalPassed = stats.reduce((s, t) => s + t.acceptedOpportunities, 0);

  const report: RunReport = {
    runId:              ctx.runId,
    botId:              ctx.botId,
    generatedAt:        new Date().toISOString(),
    cleanDataSince:     CONFIG.CLEAN_DATA_SINCE,
    periodStartMs:      Math.max(now - 72 * 3_600_000, sinceMs),
    periodEndMs:        now,
    durationHours:      Math.min(72, (now - sinceMs) / 3_600_000),
    totalBlocks:        0,
    strategies:         stats,
    captureStats,
    bestStrategyId:     best,
    worstStrategyId:    worst,
    liveReadinessScore: score,
    blockers,
    summary: `${totalPassed} passed opportunities across ${STRATEGY_IDS.length} strategies ` +
             `since ${CONFIG.CLEAN_DATA_SINCE}. Live readiness: ${score}/100.`,
  };

  const outPath = path.resolve(process.cwd(), 'logs', `report-${ctx.runId.slice(0, 8)}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  return report;
}
