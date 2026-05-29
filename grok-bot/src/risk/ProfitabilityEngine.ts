export interface CostModel {
  gasEstimateEth:   number;
  slippageBps:      number;
  dexFeeBps:        number;
  flashLoanFeeBps:  number;
  safetyBufferBps:  number;
  revertRiskBps:    number;
}

export interface ProfitabilityResult {
  grossEdgeBps:        number;
  gasAsBps:            number;
  totalCostsBps:       number;
  netEdgeBps:          number;
  estimatedGasEth:     string;
  profitable:          boolean;
  reason:              string;
}

const DEFAULT_COSTS: CostModel = {
  gasEstimateEth:  0.0003,  // Base L2 conservative — real avg ~0.00005
  slippageBps:     5,
  dexFeeBps:       5,       // overridden per fee tier
  flashLoanFeeBps: 0,       // Balancer V2: 0%
  safetyBufferBps: 10,
  revertRiskBps:   5,
};

export function computeProfitability(
  grossEdgeBps:    number,
  probeSizeEth:    number,
  costs:           Partial<CostModel> = {},
  minNetEdgeBps:   number = 5,
): ProfitabilityResult {
  const c = { ...DEFAULT_COSTS, ...costs };

  // Convert gas cost to bps relative to probe trade size
  const gasAsBps = (c.gasEstimateEth / probeSizeEth) * 10_000;

  const totalCostsBps =
    gasAsBps
    + c.slippageBps
    + c.dexFeeBps
    + c.flashLoanFeeBps
    + c.safetyBufferBps
    + c.revertRiskBps;

  const netEdgeBps = grossEdgeBps - totalCostsBps;
  const profitable = netEdgeBps >= minNetEdgeBps;

  const reason = profitable
    ? `Net ${netEdgeBps.toFixed(2)}bps ≥ threshold ${minNetEdgeBps}bps`
    : grossEdgeBps <= 0
      ? 'No gross edge — DEX tracks fair value'
      : `Net ${netEdgeBps.toFixed(2)}bps below threshold after ${totalCostsBps.toFixed(2)}bps costs`;

  return {
    grossEdgeBps,
    gasAsBps:        parseFloat(gasAsBps.toFixed(4)),
    totalCostsBps:   parseFloat(totalCostsBps.toFixed(4)),
    netEdgeBps:      parseFloat(netEdgeBps.toFixed(4)),
    estimatedGasEth: c.gasEstimateEth.toFixed(6),
    profitable,
    reason,
  };
}
