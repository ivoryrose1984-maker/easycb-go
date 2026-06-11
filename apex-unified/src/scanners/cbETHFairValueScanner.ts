import { ethers }              from 'ethers';
import { CbEthFairValueSignal } from '../signals/cbETHFairValueSignal';
import { executeDryRun }        from '../execution/dryRunExecutor';
import { logSignal, logRejection } from '../core/jsonlLogger';
import { isKilled }             from '../risk/strategyKillSwitch';
import { logger }               from '../core/logger';
import { isNewOpportunity }     from '../core/dedup';
import { StrategyResult }       from '../types/StrategyResult';

export class CbEthFairValueScanner {
  private signal: CbEthFairValueSignal;

  constructor(provider: ethers.Provider) {
    this.signal = new CbEthFairValueSignal(provider);
  }

  async scan(provider: ethers.Provider, blockNumber: number): Promise<StrategyResult> {
    const t0         = Date.now();
    const strategyId = 'grok.cbeth_fair_value' as const;

    if (isKilled(strategyId)) {
      return { strategyId, scanned: 0, opportunities: [], errors: 0, durationMs: 0 };
    }

    const result = await this.signal.scan(provider, blockNumber);
    const durationMs = Date.now() - t0;

    if (!result) {
      return { strategyId, scanned: 1, opportunities: [], errors: 1, durationMs };
    }

    logSignal(strategyId, {
      blockNumber,
      grossEdgeBps:  result.grossEdgeBps,
      netEdgeBps:    result.netEdgeBps,
      cexEthMid:     result.cexEthMid,
      window:        result.window.label,
      multiplier:    result.window.multiplier,
      hasOpportunity: !!result.opportunity,
    });

    if (!result.opportunity) {
      logRejection({
        strategyId,
        blockNumber,
        grossEdgeBps: result.grossEdgeBps,
        netEdgeBps:   result.netEdgeBps,
        reason:       result.opportunity === null ? 'below_threshold' : 'no_signal',
      });
      return { strategyId, scanned: 1, opportunities: [], errors: 0, durationMs };
    }

    if (!isNewOpportunity(result.opportunity.opportunityHash, blockNumber)) {
      logger.debug('cbETH', `Duplicate opp ${result.opportunity.opportunityHash} — skipped`);
      return { strategyId, scanned: 1, opportunities: [], errors: 0, durationMs };
    }

    executeDryRun(result.opportunity);

    return {
      strategyId,
      scanned:       1,
      opportunities: [result.opportunity],
      errors:        0,
      durationMs,
    };
  }
}
