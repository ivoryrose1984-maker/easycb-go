import { ethers }              from 'ethers';
import { TriangularArbSignal }  from '../signals/triangularArbSignal';
import { executeDryRun }        from '../execution/dryRunExecutor';
import { logSignal, logRejection } from '../core/jsonlLogger';
import { isKilled }             from '../risk/strategyKillSwitch';
import { isNewOpportunity }     from '../core/dedup';
import CONFIG                   from '../core/config';
import { StrategyResult }       from '../types/StrategyResult';

export class ApexTriangularScanner {
  private signal: TriangularArbSignal;

  constructor(provider: ethers.Provider) {
    this.signal = new TriangularArbSignal(provider);
  }

  async scan(blockNumber: number): Promise<StrategyResult> {
    const t0         = Date.now();
    const strategyId = 'apex.triangular' as const;

    if (isKilled(strategyId)) {
      return { strategyId, scanned: 0, opportunities: [], errors: 0, durationMs: 0 };
    }

    const results = await this.signal.scan(CONFIG.MIN_LOAN_USDC, blockNumber);

    logSignal(strategyId, {
      blockNumber,
      candidatesScanned: results.length,
      opportunities:     results.filter(r => r.opportunity).length,
    });

    const accepted = [];
    for (const r of results) {
      if (!r.opportunity) continue;
      if (!isNewOpportunity(r.opportunity.opportunityHash)) continue;
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
