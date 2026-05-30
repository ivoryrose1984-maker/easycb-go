export type RiskVerdict = 'allow' | 'block' | 'circuit_broken' | 'kill_switch' | 'daily_limit' | 'trade_limit';

export interface RiskDecision {
  verdict:     RiskVerdict;
  reason:      string;
  strategyId:  string;
  blockerId:   string | null;
}
