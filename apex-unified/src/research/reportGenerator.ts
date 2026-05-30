import { Opportunity, StrategyId } from '../types/Opportunity';
import { RunReport, StrategyStats } from '../types/RunReport';
import { scoreOpportunity }         from './opportunityScorer';
import { readOpportunities }        from '../core/jsonlLogger';
import CONFIG                       from '../core/config';
import { getRunContext }             from '../core/runContext';
import * as fs                      from 'fs';
import * as path                    from 'path';

const STRATEGY_IDS: StrategyId[] = [
  'apex.dex_spread', 'apex.triangular', 'grok.cbeth_fair_value',
];

function buildStats(strategyId: StrategyId, opps: Opportunity[]): StrategyStats {
  const mine     = opps.filter(o => o.strategyId === strategyId);
  const accepted = mine.filter(o => !o.rejectionReason);
  const rejected = mine.filter(o => !!o.rejectionReason);

  const rejBreakdown: Record<string, number> = {};
  for (const r of rejected) {
    const key = r.rejectionReason ?? 'unknown';
    rejBreakdown[key] = (rejBreakdown[key] ?? 0) + 1;
  }

  const grossTotal = accepted.reduce((s, o) => s + o.grossProfitUsd, 0);
  const netTotal   = accepted.reduce((s, o) => s + o.netProfitUsd,   0);
  const bpsArr     = accepted.map(o => o.spreadBps).sort((a, b) => a - b);
  const median     = bpsArr.length > 0 ? bpsArr[Math.floor(bpsArr.length / 2)] : 0;

  const scored       = accepted.map(scoreOpportunity);
  const noiseCount   = scored.filter(s => s.classification === 'noise').length;
  const falsePosPct  = accepted.length > 0 ? noiseCount / accepted.length : 0;

  return {
    strategyId,
    totalScans:            mine.length,
    totalOpportunities:    mine.length,
    acceptedOpportunities: accepted.length,
    rejectedOpportunities: rejected.length,
    rejectionBreakdown:    rejBreakdown,
    grossEstimatedProfitUsd: grossTotal,
    netEstimatedProfitUsd:   netTotal,
    avgGasCostEth:         0.0003,
    avgSlippageBps:        accepted.length > 0
      ? accepted.reduce((s, o) => s + o.slippageEstimate, 0) / accepted.length
      : 0,
    medianOpportunityBps:  median,
    falsePositiveRate:     falsePosPct,
    expectedValueUsd:      netTotal,
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
  else blockers.push(`High false-positive rate ${(best.falsePositiveRate * 100).toFixed(0)}% — need <30%`);

  if (best.netEstimatedProfitUsd > 0) score += 20;
  else blockers.push('Negative net profit — costs exceed edge');

  if (!CONFIG.CONTRACTS.APEX_FLASH_LOAN.startsWith('0x000')) score += 15;
  else blockers.push('Flash loan contract not deployed');

  if (process.env.PRIVATE_KEY) score += 10;
  else blockers.push('PRIVATE_KEY not set — required for live signing');

  if (CONFIG.ENABLE_BUILDER_SUBMISSION) score += 5;
  else blockers.push('ENABLE_BUILDER_SUBMISSION=false — enable for live execution');

  return { score, blockers };
}

export async function generate72HourReport(): Promise<RunReport> {
  const ctx  = getRunContext();
  const now  = Date.now();
  const all: Opportunity[] = [];

  for (let i = 0; i < 3; i++) {
    const d = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    all.push(...readOpportunities(d));
  }

  const stats = STRATEGY_IDS.map(id => buildStats(id, all));

  const byEV = [...stats].sort((a, b) => b.expectedValueUsd - a.expectedValueUsd);
  const byFP = [...stats].sort((a, b) => a.falsePositiveRate - b.falsePositiveRate);

  const { score, blockers } = liveReadinessScore(stats);

  const best  = byEV[0]?.expectedValueUsd  > 0       ? byEV[0].strategyId  : null;
  const worst = byFP[byFP.length - 1]?.totalOpportunities > 0 ? byFP[byFP.length - 1].strategyId : null;

  const report: RunReport = {
    runId:          ctx.runId,
    botId:          ctx.botId,
    generatedAt:    new Date().toISOString(),
    periodStartMs:  now - 72 * 3_600_000,
    periodEndMs:    now,
    durationHours:  72,
    totalBlocks:    0,
    strategies:     stats,
    bestStrategyId: best,
    worstStrategyId: worst,
    liveReadinessScore: score,
    blockers,
    summary:        `${all.length} total opportunities across ${STRATEGY_IDS.length} strategies over 72h. ` +
                    `Live readiness: ${score}/100.`,
  };

  const outPath = path.resolve(process.cwd(), 'logs', `report-${ctx.runId.slice(0, 8)}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  return report;
}
