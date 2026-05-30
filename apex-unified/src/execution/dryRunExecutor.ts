import { Opportunity } from '../types/Opportunity';
import { logOpportunity } from '../core/jsonlLogger';
import { logger } from '../core/logger';
import { sendAlert } from '../infrastructure/telegramAlert';
import CONFIG, { usdcToUsd } from '../core/config';

export interface DryRunResult {
  logged:    boolean;
  alerted:   boolean;
  hash:      string;
  netBps:    number;
}

export function executeDryRun(opp: Opportunity): DryRunResult {
  logOpportunity(opp);

  const netBps = opp.spreadBps;

  logger.info('DRY_RUN',
    `[OPPORTUNITY] strat=${opp.strategyId} hash=${opp.opportunityHash} ` +
    `spread=${opp.spreadBps}bps gross=$${opp.grossProfitUsd.toFixed(2)} block=${opp.blockNumber}`
  );

  const msg =
    `Opportunity detected\n` +
    `Strategy: ${opp.strategyId}\n` +
    `Route: ${opp.route}\n` +
    `Spread: ${opp.spreadBps}bps\n` +
    `Block: ${opp.blockNumber}\n` +
    `Hash: ${opp.opportunityHash}\n` +
    `[DRY RUN — not executed]`;

  sendAlert(msg);

  return { logged: true, alerted: true, hash: opp.opportunityHash, netBps };
}
