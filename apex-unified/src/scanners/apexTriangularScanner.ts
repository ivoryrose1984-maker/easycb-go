import { ethers }              from 'ethers';
import { TriangularArbSignal }  from '../signals/triangularArbSignal';
import { executeDryRun }        from '../execution/dryRunExecutor';
import { logSignal, logRejection } from '../core/jsonlLogger';
import { captureDetected }      from '../core/captureTelemetry';
import { isKilled }             from '../risk/strategyKillSwitch';
import { isNewOpportunity }     from '../core/dedup';
import CONFIG                   from '../core/config';
import { StrategyResult }       from '../types/StrategyResult';

export class ApexTriangularScanner {
  private signal: TriangularArbSignal;

  constructor(provider: ethers.Provider) {
    this.signal = new TriangularArbSignal(provider);
  }

  async scan(blockNumber: number, ethPriceUsd: bigint = 3_000_000_000n): Promise<StrategyResult> {
    const t0         = Date.now();
    const strategyId = 'apex.triangular' as const;

    if (isKilled(strategyId)) {
      return { strategyId, scanned: 0, opportunities: [], errors: 0, durationMs: 0 };
    }

    const results = await this.signal.scan(5_000n * 1_000_000n, blockNumber, ethPriceUsd);

    // Log every path individually — sub-threshold included — so bps distribution
    // is captured for MIN_NET_EDGE_BPS tuning during the dry run.
    for (const r of results) {
      const hasOpp = !!r.opportunity;
      const route  = `${r.tokens[0].slice(0,8)}→${r.tokens[1].slice(0,8)}→${r.tokens[2].slice(0,8)}`;
      logSignal(strategyId, {
        blockNumber,
        route,
        fees:      r.fees,
        spreadBps: r.spreadBps,
        grossProfitUsd: r.opportunity?.grossProfitUsd ?? 0,
        hasOpp,
      });
      if (!hasOpp) {
        const skipReason = `spread=${r.spreadBps}bps below threshold`;
        logRejection({ strategyId, blockNumber, fees: r.fees, spreadBps: r.spreadBps, reason: skipReason });
        captureDetected({
          opportunityId: `tri-${r.tokens.join('-')}-${r.fees.join('-')}-${blockNumber}`,
          strategyId,
          block:         blockNumber,
          path:          route,
          spreadBps:     r.spreadBps,
          grossUsd:      0,
          netUsd:        0,
          loanSize:      r.amountIn.toString(),
          filterResult:  'skip',
          skipReason,
        });
      }
    }

    const accepted = [];
    for (const r of results) {
      if (!r.opportunity) continue;
      if (!isNewOpportunity(r.opportunity.opportunityHash, blockNumber)) {
        captureDetected({
          opportunityId: r.opportunity.opportunityHash,
          strategyId,
          block:         blockNumber,
          path:          r.opportunity.route,
          spreadBps:     r.opportunity.spreadBps,
          grossUsd:      r.opportunity.grossProfitUsd,
          netUsd:        r.opportunity.netProfitUsd,
          loanSize:      r.opportunity.quotedInput,
          filterResult:  'skip',
          skipReason:    'dedup_ttl',
        });
        continue;
      }
      captureDetected({
        opportunityId: r.opportunity.opportunityHash,
        strategyId,
        block:         blockNumber,
        path:          r.opportunity.route,
        spreadBps:     r.opportunity.spreadBps,
        grossUsd:      r.opportunity.grossProfitUsd,
        netUsd:        r.opportunity.netProfitUsd,
        loanSize:      r.opportunity.quotedInput,
        filterResult:  'pass',
        skipReason:    null,
      });
      executeDryRun(r.opportunity);
      accepted.push(r.opportunity);
    }

    return {
      strategyId,
      scanned:   results.length,
      opportunities: accepted,
      errors:    0,
      durationMs: Date.now() - t0,
    };
  }
}
