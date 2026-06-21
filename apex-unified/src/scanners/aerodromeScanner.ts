import { ethers }           from 'ethers';
import { AerodromeSignal }  from '../signals/aerodromeSignal';
import { executeDryRun }    from '../execution/dryRunExecutor';
import { logSignal, logRejection } from '../core/jsonlLogger';
import { captureDetected }  from '../core/captureTelemetry';
import { isKilled }         from '../risk/strategyKillSwitch';
import { isNewOpportunity } from '../core/dedup';
import { logger }           from '../core/logger';
import CONFIG               from '../core/config';
import { StrategyResult }   from '../types/StrategyResult';

const PAIRS = [
  // Volatile pairs — Aerodrome vs Uni V3 + PancakeSwap V3
  { tokenIn: CONFIG.TOKENS.USDC,  tokenOut: CONFIG.TOKENS.WETH,  name: 'USDC/WETH',  stable: false },
  { tokenIn: CONFIG.TOKENS.WETH,  tokenOut: CONFIG.TOKENS.cbETH, name: 'WETH/cbETH', stable: false },
  { tokenIn: CONFIG.TOKENS.WETH,  tokenOut: CONFIG.TOKENS.AERO,  name: 'WETH/AERO',  stable: false },
  { tokenIn: CONFIG.TOKENS.USDC,  tokenOut: CONFIG.TOKENS.AERO,  name: 'USDC/AERO',  stable: false },
  { tokenIn: CONFIG.TOKENS.USDC,  tokenOut: CONFIG.TOKENS.cbBTC, name: 'USDC/cbBTC', stable: false },
  { tokenIn: CONFIG.TOKENS.WETH,  tokenOut: CONFIG.TOKENS.cbBTC, name: 'WETH/cbBTC', stable: false },
  // Stable pairs — Aerodrome Solidly AMM vs Uni V3 + PancakeSwap V3
  { tokenIn: CONFIG.TOKENS.USDC,  tokenOut: CONFIG.TOKENS.DAI,   name: 'USDC/DAI',   stable: true  },
  { tokenIn: CONFIG.TOKENS.USDC,  tokenOut: CONFIG.TOKENS.USDT,  name: 'USDC/USDT',  stable: true  },
];

export class AerodromeScanner {
  private signal: AerodromeSignal;

  constructor(provider: ethers.Provider) {
    this.signal = new AerodromeSignal(provider);
  }

  async scan(blockNumber: number, ethPriceUsd: bigint = 3_000_000_000n): Promise<StrategyResult> {
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
        this.signal.scan(pair, loanAmount, blockNumber, ethPriceUsd)
      )
    );

    const opportunities = [];
    let errors = 0;

    for (const r of results) {
      if (r.status === 'rejected') { errors++; continue; }
      const res = r.value;
      if (!res) continue;

      logSignal(strategyId, {
        blockNumber,
        pair:         res.pair,
        spreadBps:    res.spreadBps,
        buyDex:       res.buyDex,
        sellDex:      res.sellDex,
        filterResult: res.filterResult,
        hasOpp:       !!res.opportunity,
      });

      // Anomaly: |spread| > 2000bps — log as anomaly, not a skip
      if (res.filterResult === 'anomaly') {
        logRejection({ strategyId, blockNumber, pair: res.pair, reason: `anomaly spread=${res.spreadBps}bps` });
        captureDetected({
          opportunityId: `aero-${res.pair}-${blockNumber}-anomaly`,
          strategyId,
          block:         blockNumber,
          path:          res.pair,
          spreadBps:     res.spreadBps,
          grossUsd:      0,
          netUsd:        0,
          loanSize:      res.loanAmount.toString(),
          filterResult:  'anomaly',
          skipReason:    `spread=${res.spreadBps}bps exceeds ±2000bps anomaly gate`,
        });
        continue;
      }

      if (!res.opportunity) {
        const skipReason = `spread=${res.spreadBps}bps below threshold`;
        logRejection({ strategyId, blockNumber, pair: res.pair, reason: skipReason });
        captureDetected({
          opportunityId: `aero-${res.pair}-${blockNumber}-${res.spreadBps}`,
          strategyId,
          block:         blockNumber,
          path:          res.pair,
          spreadBps:     res.spreadBps,
          grossUsd:      0,
          netUsd:        0,
          loanSize:      res.loanAmount.toString(),
          filterResult:  'skip',
          skipReason,
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
      void executeDryRun(res.opportunity);
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
