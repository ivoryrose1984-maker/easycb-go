import { StrategyId } from './Opportunity';

export interface StrategyStats {
  strategyId:          StrategyId;
  totalScans:          number;
  totalOpportunities:  number;
  acceptedOpportunities: number;
  rejectedOpportunities: number;
  rejectionBreakdown:  Record<string, number>;
  grossEstimatedProfitUsd: number;
  netEstimatedProfitUsd:   number;
  avgGasCostEth:       number;
  avgSlippageBps:      number;
  medianOpportunityBps: number;
  falsePositiveRate:   number;    // 0–1
  expectedValueUsd:    number;
}

export interface RunReport {
  runId:              string;
  botId:              string;
  generatedAt:        string;
  periodStartMs:      number;
  periodEndMs:        number;
  durationHours:      number;
  totalBlocks:        number;
  strategies:         StrategyStats[];
  bestStrategyId:     StrategyId | null;
  worstStrategyId:    StrategyId | null;
  liveReadinessScore: number;     // 0–100
  blockers:           string[];
  summary:            string;
}
