import { ethers }           from 'ethers';
import { AerodromeSignal }  from '../signals/aerodromeSignal';
import { executeDryRun }    from '../execution/dryRunExecutor';
import { logSignal, logRejection } from '../core/jsonlLogger';
import { isKilled }         from '../risk/strategyKillSwitch';
import { isNewOpportunity } from '../core/dedup';
import { logger }           from '../core/logger';
import CONFIG               from '../core/config';
import { StrategyResult }   from '../types/StrategyResult';

const PAIRS = [
  { tokenIn: CONFIG.TOKENS.USDC,  tokenOut: CONFIG.TOKENS.WETH,  name: 'USDC/WETH',  stable: false },
  { tokenIn: CONFIG.TOKENS.WETH,  tokenOut: CONFIG.TOKENS.cbETH, name: 'WETH/cbETH', stable: false },
  { tokenIn: CONFIG.TOKENS.USDC,  tokenOut: CONFIG.TOKENS.AERO,  name: 'USDC/AERO',  stable: false },
  { tokenIn: CONFIG.TOKENS.USDC,  tokenOut: CONFIG.TOKENS.USDbC, name: 'USDC/USDbC', stable: true  },
];

export class AerodromeScanner {
  private signal: AerodromeSignal;

  constructor(provider: ethers.Provider) {
    this.signal = new AerodromeSignal(provider);
  }

  async scan(blockNumber: number): Promise<StrategyResult> {
    const t0         = Date.now();
    const strategyId = 'apex.aerodrome_spread' as const;

    if (isKilled(strategyId)) {
      return { strategyId, scanned: 0, opportunities: [], errors: 0, durationMs: 0 };
    }

    const probes = PAIRS.map(pair => ({
      pair,
      loanAmount: pair.tokenIn === CONFIG.TOKENS.WETH
        ? ethers.parseEther('3')
        : CONFIG.MIN_LOAN_USDC,
    }));

    const results = await Promise.allSettled(
      probes.map(({ pair, loanAmount }) =>
        this.signal.scan(pair, loanAmount, blockNumber)
      )
    );

    const opportunities = [];
    let errors = 0;

    for (const r of results) {
      if (r.status === 'rejected') { errors++; continue; }
      const res = r.value;
      if (!res) continue;  // null = no pools exist for pair, not an error

      logSignal(strategyId, {
        blockNumber,
        pair:      res.pair,
        spreadBps: res.spreadBps,
        buyDex:    res.buyDex,
        sellDex:   res.sellDex,
        hasOpp:    !!res.opportunity,
      });

      if (!res.opportunity) {
        logRejection({ strategyId, blockNumber, pair: res.pair, reason: `spread=${res.spreadBps}bps below threshold` });
        continue;
      }

      if (!isNewOpportunity(res.opportunity.opportunityHash)) continue;

      executeDryRun(res.opportunity);
      opportunities.push(res.opportunity);
    }

    return {
      strategyId,
      scanned:    PAIRS.length,
      opportunities,
      errors,
      durationMs: Date.now() - t0,
    };
  }
}
