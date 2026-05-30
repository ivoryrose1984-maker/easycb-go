export type StrategyId =
  | 'apex.dex_spread'
  | 'apex.triangular'
  | 'grok.cbeth_fair_value'
  | 'atlas.replay'
  | 'atlas.backtest';

export type SafetyDecision = 'dry_run_only' | 'live_eligible' | 'blocked';

export interface Opportunity {
  // Identity
  timestamp:         string;
  blockNumber:       number;
  chainId:           number;
  botId:             string;
  runId:             string;
  strategyId:        StrategyId;
  opportunityHash:   string;

  // Route
  tokenIn:           string;
  tokenOut:          string;
  route:             string;       // human-readable e.g. "USDC→WETH→cbETH→USDC"
  dex:               string;
  feeTier:           number;

  // Prices
  quotedInput:       string;       // bigint as string
  quotedOutput:      string;       // bigint as string
  fairValuePrice:    number | null;
  dexPrice:          number;
  cexPrice:          number | null;

  // Edge
  spreadBps:         number;
  grossProfitUsd:    number;
  netProfitUsd:      number;

  // Costs
  gasEstimate:       string;
  slippageEstimate:  number;
  flashLoanFeeEst:   number;
  builderFeeEst:     number;
  confidenceScore:   number;       // 0–100

  // Decision
  rejectionReason:   string | null;
  safetyDecision:    SafetyDecision;
  dryRunOnly:        boolean;
  liveEligible:      boolean;
}
