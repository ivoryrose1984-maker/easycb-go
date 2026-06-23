import { Opportunity } from '../types/Opportunity';
import { scoreOpportunity } from './opportunityScorer';

export interface BacktestResult {
  totalOpps:       number;
  executed:        number;
  totalGrossUsd:   number;
  totalNetUsd:     number;
  winRate:         number;
  avgEdgeBps:      number;
  sharpeProxy:     number;
}

export function backtest(opps: Opportunity[], minBps: number = 5): BacktestResult {
  const eligible = opps.filter(o => o.spreadBps >= minBps);
  const scored   = eligible.map(scoreOpportunity).filter(s => s.classification !== 'noise');

  const gross = scored.reduce((s, o) => s + o.opportunity.grossProfitUsd, 0);
  const net   = scored.reduce((s, o) => s + o.opportunity.netProfitUsd,   0);
  const bps   = scored.map(o => o.opportunity.spreadBps);
  const avg   = bps.length > 0 ? bps.reduce((a, b) => a + b, 0) / bps.length : 0;

  const variance = bps.length > 1
    ? bps.reduce((s, v) => s + (v - avg) ** 2, 0) / bps.length
    : 1;
  const sharpe = avg / (Math.sqrt(variance) || 1);

  return {
    totalOpps:     opps.length,
    executed:      scored.length,
    totalGrossUsd: gross,
    totalNetUsd:   net,
    winRate:       opps.length > 0 ? scored.length / opps.length : 0,
    avgEdgeBps:    avg,
    sharpeProxy:   sharpe,
  };
}
