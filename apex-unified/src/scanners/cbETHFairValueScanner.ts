import { ethers }              from 'ethers';
import { CbEthFairValueSignal } from '../signals/cbETHFairValueSignal';
import { executeDryRun }        from '../execution/dryRunExecutor';
import { logSignal, logRejection } from '../core/jsonlLogger';
import { captureDetected }      from '../core/captureTelemetry';
import { isKilled }             from '../risk/strategyKillSwitch';
import { logger }               from '../core/logger';
import { isNewOpportunity }     from '../core/dedup';
import { rpcHealth }            from '../core/rpcHealth';
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
      latencyMs:      durationMs,
      rpcState:       rpcHealth.getState(),
      grossEdgeBps:   result.grossEdgeBps,
      netEdgeBps:     result.netEdgeBps,
      totalCostBps:   result.totalCostBps,
      threshold:      result.threshold,
      cexEthMid:      result.cexEthMid,
      window:         result.window.label,
      multiplier:     result.window.multiplier,
      decision:       result.opportunity ? 'opportunity' : 'below_threshold',
    });

    if (!result.opportunity) {
      const skipReason = 'below_threshold';
      logRejection({
        strategyId,
        blockNumber,
        grossEdgeBps:  result.grossEdgeBps,
        netEdgeBps:    result.netEdgeBps,
        totalCostBps:  result.totalCostBps,
        threshold:     result.threshold,
        reason:        skipReason,
      });
      captureDetected({
        opportunityId: `cbeth-${blockNumber}`,
        strategyId,
        block:         blockNumber,
        path:          'cbETH/ETH',
        spreadBps:     result.grossEdgeBps,
        grossUsd:      0,
        netUsd:        0,
        loanSize:      '0',
        filterResult:  'skip',
        skipReason,
      });
      return { strategyId, scanned: 1, opportunities: [], errors: 0, durationMs };
    }

    if (!isNewOpportunity(result.opportunity.opportunityHash, blockNumber)) {
      logger.debug('cbETH', `Duplicate opp ${result.opportunity.opportunityHash} — skipped`);
      captureDetected({
        opportunityId: result.opportunity.opportunityHash,
        strategyId,
        block:         blockNumber,
        path:          result.opportunity.route,
        spreadBps:     result.opportunity.spreadBps,
        grossUsd:      result.opportunity.grossProfitUsd,
        netUsd:        result.opportunity.netProfitUsd,
        loanSize:      result.opportunity.quotedInput,
        filterResult:  'skip',
        skipReason:    'dedup_ttl',
      });
      return { strategyId, scanned: 1, opportunities: [], errors: 0, durationMs };
    }

    captureDetected({
      opportunityId: result.opportunity.opportunityHash,
      strategyId,
      block:         blockNumber,
      path:          result.opportunity.route,
      spreadBps:     result.opportunity.spreadBps,
      grossUsd:      result.opportunity.grossProfitUsd,
      netUsd:        result.opportunity.netProfitUsd,
      loanSize:      result.opportunity.quotedInput,
      filterResult:  'pass',
      skipReason:    null,
    });
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
