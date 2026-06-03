import { Opportunity } from '../types/Opportunity';
import { backtest }    from './backtester';

export interface OptimizationResult {
  bestMinBps:     number;
  bestNetUsd:     number;
  trialResults:   Array<{ minBps: number; netUsd: number; winRate: number }>;
}

export function optimizeThreshold(opps: Opportunity[], range = [1, 2, 5, 10, 15, 20, 30]): OptimizationResult {
  const trials = range.map(minBps => {
    const r = backtest(opps, minBps);
    return { minBps, netUsd: r.totalNetUsd, winRate: r.winRate };
  });

  if (trials.length === 0) return { bestMinBps: 0, bestNetUsd: 0, trialResults: [] };
  const best = trials.reduce((b, t) => t.netUsd > b.netUsd ? t : b, trials[0]);

  return {
    bestMinBps:   best.minBps,
    bestNetUsd:   best.netUsd,
    trialResults: trials,
  };
}
