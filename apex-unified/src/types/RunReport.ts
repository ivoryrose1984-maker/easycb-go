import { StrategyId } from './Opportunity';
import { CaptureStats } from '../core/captureTelemetry';

export { CaptureStats };

export interface StrategyStats {
  strategyId:          StrategyId;
  disabled?:           string;    // set when the corresponding ENABLE_* flag is false
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
  cleanDataSince:     string;           // ISO timestamp — all figures exclude events before this
  periodStartMs:      number;
  periodEndMs:        number;
  durationHours:      number;
  totalBlocks:        number;
  strategies:         StrategyStats[];
  captureStats:       CaptureStats[];   // WO-1: per-strategy lifecycle telemetry
  bestStrategyId:     StrategyId | null;
  worstStrategyId:    StrategyId | null;
  liveReadinessScore: number;           // 0–100
  blockers:           string[];
  summary:            string;
}
