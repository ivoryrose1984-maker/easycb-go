import { Opportunity } from '../types/Opportunity';

export interface ScoredOpportunity {
  opportunity:    Opportunity;
  score:          number;
  classification: 'strong' | 'marginal' | 'noise';
  notes:          string[];
}

export function scoreOpportunity(opp: Opportunity): ScoredOpportunity {
  let score = 0;
  const notes: string[] = [];

  // Base score from spread
  score += Math.min(opp.spreadBps * 2, 50);

  // cbETH fair-value signal has highest confidence
  if (opp.strategyId === 'grok.cbeth_fair_value') {
    score += 20;
    if (opp.fairValuePrice !== null) {
      notes.push('deterministic fair-value anchor');
    }
  }

  // CEX context confirmation
  if (opp.cexPrice !== null) {
    score += 10;
    notes.push('CEX context available');
  }

  // Confidence from signal layer
  score += opp.confidenceScore * 0.2;

  // Triangular has more slippage risk — discount
  if (opp.strategyId === 'apex.triangular') {
    score -= 10;
    notes.push('triangular slippage risk');
  }

  const finalScore = Math.min(100, Math.max(0, Math.round(score)));

  return {
    opportunity:    opp,
    score:          finalScore,
    classification: finalScore >= 70 ? 'strong' : finalScore >= 40 ? 'marginal' : 'noise',
    notes,
  };
}

export function rankOpportunities(opps: Opportunity[]): ScoredOpportunity[] {
  return opps.map(scoreOpportunity).sort((a, b) => b.score - a.score);
}
