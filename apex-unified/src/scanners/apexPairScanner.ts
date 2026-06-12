import { ethers }          from 'ethers';
import { DexSpreadSignal } from '../signals/dexSpreadSignal';
import { executeDryRun }   from '../execution/dryRunExecutor';
import { logSignal, logRejection } from '../core/jsonlLogger';
import { captureDetected } from '../core/captureTelemetry';
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
  { tokenIn: CONFIG.TOKENS.USDbC, tokenOut: CONFIG.TOKENS.WETH,  name: 'USDbC/WETH' },
  { tokenIn: CONFIG.TOKENS.USDC,  tokenOut: CONFIG.TOKENS.USDbC, name: 'USDC/USDbC' },
  { tokenIn: CONFIG.TOKENS.WETH,  tokenOut: CONFIG.TOKENS.AERO,  name: 'WETH/AERO'  },
  { tokenIn: CONFIG.TOKENS.USDC,  tokenOut: CONFIG.TOKENS.AERO,  name: 'USDC/AERO'  },
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

    // USDC/USDT/DAI/USDbC pairs: 5000 USDC probe for realistic signal resolution
    // WETH tokenIn pairs: 3 ETH probe (~same order of magnitude)
    const WETH_18_PROBE  = ethers.parseEther('3');
    const USDC_PROBE     = 5_000n * 1_000_000n;
    const results = await Promise.allSettled(
      PAIRS.map(pair => {
        const probe = pair.tokenIn === CONFIG.TOKENS.WETH ? WETH_18_PROBE : USDC_PROBE;
        return this.signal.scan(pair, probe, blockNumber, ethPriceUsd);
      })
    );

    const opportunities = [];
    let errors = 0;

    for (const r of results) {
      if (r.status === 'rejected') { errors++; continue; }
      const res = r.value;
      if (!res) continue;

      logSignal(strategyId, {
        blockNumber,
        pair:      res.pair,
        spreadBps: res.spreadBps,
        buyDex:    res.buyDex,
        buyFee:    res.buyFee,
        sellDex:   res.sellDex,
        sellFee:   res.sellFee,
        hasOpp:    !!res.opportunity,
      });

      if (!res.opportunity) {
        captureDetected({
          opportunityId: `dex-${res.pair}-${blockNumber}-${res.spreadBps}`,
          strategyId:    strategyId,
          block:         blockNumber,
          path:          res.pair,
          spreadBps:     res.spreadBps,
          grossUsd:      0,
          netUsd:        0,
          loanSize:      res.loanAmount.toString(),
          filterResult:  'skip',
          skipReason:    res.rejectionReason ?? 'below_threshold',
        });
        continue;
      }

      if (!isNewOpportunity(res.opportunity.opportunityHash, blockNumber)) {
        captureDetected({
          opportunityId: res.opportunity.opportunityHash,
          strategyId,
          block:         blockNumber,
          path:          res.opportunity.route,
          spreadBps:     res.opportunity.spreadBps,
          grossUsd:      res.opportunity.grossProfitUsd,
          netUsd:        res.opportunity.netProfitUsd,
          loanSize:      res.opportunity.quotedInput,
          filterResult:  'skip',
          skipReason:    'dedup_ttl',
        });
        continue;
      }

      captureDetected({
        opportunityId: res.opportunity.opportunityHash,
        strategyId,
        block:         blockNumber,
        path:          res.opportunity.route,
        spreadBps:     res.opportunity.spreadBps,
        grossUsd:      res.opportunity.grossProfitUsd,
        netUsd:        res.opportunity.netProfitUsd,
        loanSize:      res.opportunity.quotedInput,
        filterResult:  'pass',
        skipReason:    null,
      });
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
