import { ethers }       from 'ethers';
import { DexSpreadSignal } from '../signals/dexSpreadSignal';
import { executeDryRun }   from '../execution/dryRunExecutor';
import { logSignal, logRejection } from '../core/jsonlLogger';
import { isKilled }        from '../risk/strategyKillSwitch';
import { isNewOpportunity } from '../core/dedup';
import { logger }          from '../core/logger';
import CONFIG              from '../core/config';
import { StrategyResult }  from '../types/StrategyResult';

const PAIRS = [
  { tokenIn: CONFIG.TOKENS.USDC,  tokenOut: CONFIG.TOKENS.WETH,  name: 'USDC/WETH'  },
  { tokenIn: CONFIG.TOKENS.USDT,  tokenOut: CONFIG.TOKENS.WETH,  name: 'USDT/WETH'  },
  { tokenIn: CONFIG.TOKENS.DAI,   tokenOut: CONFIG.TOKENS.WETH,  name: 'DAI/WETH'   },
  { tokenIn: CONFIG.TOKENS.USDC,  tokenOut: CONFIG.TOKENS.USDT,  name: 'USDC/USDT'  },
  { tokenIn: CONFIG.TOKENS.USDC,  tokenOut: CONFIG.TOKENS.DAI,   name: 'USDC/DAI'   },
  { tokenIn: CONFIG.TOKENS.USDC,  tokenOut: CONFIG.TOKENS.cbETH, name: 'USDC/cbETH' },
  { tokenIn: CONFIG.TOKENS.WETH,  tokenOut: CONFIG.TOKENS.cbETH, name: 'WETH/cbETH' },
  { tokenIn: CONFIG.TOKENS.USDC,  tokenOut: CONFIG.TOKENS.cbBTC, name: 'USDC/cbBTC' },
  { tokenIn: CONFIG.TOKENS.WETH,  tokenOut: CONFIG.TOKENS.cbBTC, name: 'WETH/cbBTC' },
];

export class ApexPairScanner {
  private signal: DexSpreadSignal;

  constructor(provider: ethers.Provider) {
    this.signal = new DexSpreadSignal(provider);
  }

  async scan(blockNumber: number, ethPriceUsd: bigint): Promise<StrategyResult> {
    const t0         = Date.now();
    const strategyId = 'apex.dex_spread' as const;

    if (isKilled(strategyId)) {
      return { strategyId, scanned: 0, opportunities: [], errors: 0, durationMs: 0 };
    }

    // USDC/USDT/DAI pairs use 6-decimal probe; WETH tokenIn pairs use 18-decimal probe
    const WETH_18_PROBE = ethers.parseEther('3');
    const results = await Promise.allSettled(
      PAIRS.map(pair => {
        const probe = pair.tokenIn === CONFIG.TOKENS.WETH ? WETH_18_PROBE : CONFIG.MIN_LOAN_USDC;
        return this.signal.scan(pair, probe, blockNumber, ethPriceUsd);
      })
    );

    const opportunities = [];
    let errors = 0;

    for (const r of results) {
      if (r.status === 'rejected') { errors++; continue; }
      const res = r.value;
      if (!res) { errors++; continue; }

      logSignal(strategyId, {
        blockNumber,
        pair:      res.pair,
        spreadBps: res.spreadBps,
        buyFee:    res.buyFee,
        sellFee:   res.sellFee,
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
      scanned:   PAIRS.length,
      opportunities,
      errors,
      durationMs: Date.now() - t0,
    };
  }
}
