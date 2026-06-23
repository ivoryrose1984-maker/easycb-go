import { ethers }              from 'ethers';
import { CbBtcFairValueSignal } from '../signals/cbBTCFairValueSignal';
import { executeDryRun }        from '../execution/dryRunExecutor';
import { logSignal, logRejection } from '../core/jsonlLogger';
import { captureDetected }      from '../core/captureTelemetry';
import { isKilled }             from '../risk/strategyKillSwitch';
import { logger }               from '../core/logger';
import { isNewOpportunity }     from '../core/dedup';
import { rpcHealth }            from '../core/rpcHealth';
import { StrategyResult }       from '../types/StrategyResult';

export class CbBtcFairValueScanner {
  private signal: CbBtcFairValueSignal;

  constructor(provider: ethers.Provider) {
    this.signal = new CbBtcFairValueSignal(provider);
  }

  async scan(blockNumber: number): Promise<StrategyResult> {
    const t0         = Date.now();
    const strategyId = 'grok.cbbtc_fair_value' as const;

    if (isKilled(strategyId)) {
      return { strategyId, scanned: 0, opportunities: [], errors: 0, durationMs: 0 };
    }

    const result = await this.signal.scan(blockNumber);
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
        opportunityId: `cbbtc-${blockNumber}`,
        strategyId,
        block:         blockNumber,
        path:          'cbBTC/ETH',
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
      logger.debug('cbBTC', `Duplicate opp ${result.opportunity.opportunityHash} — skipped`);
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
    void executeDryRun(result.opportunity);

    return {
      strategyId,
      scanned:       1,
      opportunities: [result.opportunity],
      errors:        0,
      durationMs,
    };
  }
}
