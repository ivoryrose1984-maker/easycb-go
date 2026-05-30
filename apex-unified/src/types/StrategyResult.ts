import { StrategyId, Opportunity } from './Opportunity';

export interface StrategyResult {
  strategyId:      StrategyId;
  scanned:         number;
  opportunities:   Opportunity[];
  errors:          number;
  durationMs:      number;
}
