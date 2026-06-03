import { ethers } from 'ethers';
import CONFIG, { usdcToUsd } from '../core/config';
import { Opportunity } from '../types/Opportunity';
import { opportunityHash } from '../core/dedup';
import { logger } from '../core/logger';

const AERODROME_ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)',
];

const UNI_QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160,uint32,uint256)',
];

const UNI_FEES = [100, 500, 3000, 10000];

export interface AerodromeSpreadResult {
  pair:        string;
  tokenIn:     string;
  tokenOut:    string;
  buyDex:      string;
  sellDex:     string;
  spreadBps:   number;
  loanAmount:  bigint;
  grossProfit: bigint;
  opportunity: Opportunity | null;
}

export class AerodromeSignal {
  private router:    ethers.Contract;
  private uniQuoter: ethers.Contract;

  constructor(provider: ethers.Provider) {
    this.router    = new ethers.Contract(CONFIG.CONTRACTS.AERODROME_ROUTER, AERODROME_ROUTER_ABI, provider);
    this.uniQuoter = new ethers.Contract(CONFIG.CONTRACTS.UNI_QUOTER,       UNI_QUOTER_ABI,       provider);
  }

  async scan(
    pair:        { tokenIn: string; tokenOut: string; name: string; stable: boolean },
    loanAmount:  bigint,
    blockNumber: number,
  ): Promise<AerodromeSpreadResult | null> {
    try {
      const factory = CONFIG.CONTRACTS.AERODROME_FACTORY;

      // ── Phase 1: buy quotes tokenIn → tokenOut (Aerodrome + Uni V3) ──
      const [aeroBuyOut, uniBuyRaw] = await Promise.all([
        this.router.getAmountsOut(loanAmount, [{
          from: pair.tokenIn, to: pair.tokenOut, stable: pair.stable, factory,
        }]).then((a: bigint[]) => a[1]).catch(() => 0n),
        Promise.all(UNI_FEES.map(fee =>
          this.uniQuoter.quoteExactInputSingle.staticCall({
            tokenIn: pair.tokenIn, tokenOut: pair.tokenOut,
            amountIn: loanAmount, fee, sqrtPriceLimitX96: 0,
          }).then((r: any) => r[0] as bigint).catch(() => 0n)
        )),
      ]);

      const bestUniBuy    = uniBuyRaw.reduce((a, b) => b > a ? b : a, 0n);
      const bestUniBuyFee = UNI_FEES[uniBuyRaw.indexOf(bestUniBuy)] ?? 3000;

      const buyOnAero = aeroBuyOut > bestUniBuy && aeroBuyOut > 0n;
      const bestBuyOut = buyOnAero ? aeroBuyOut : bestUniBuy;
      const bestBuyDex = buyOnAero ? 'aerodrome' : `uni-v3@${bestUniBuyFee}`;

      if (bestBuyOut === 0n) return null;

      // ── Phase 2: sell quotes tokenOut → tokenIn (Aerodrome + Uni V3) ──
      const [aeroSellOut, uniSellRaw] = await Promise.all([
        this.router.getAmountsOut(bestBuyOut, [{
          from: pair.tokenOut, to: pair.tokenIn, stable: pair.stable, factory,
        }]).then((a: bigint[]) => a[1]).catch(() => 0n),
        Promise.all(UNI_FEES.map(fee => {
          // Skip the same pool if we bought on Uni V3
          if (!buyOnAero && fee === bestUniBuyFee) return Promise.resolve(0n);
          return this.uniQuoter.quoteExactInputSingle.staticCall({
            tokenIn: pair.tokenOut, tokenOut: pair.tokenIn,
            amountIn: bestBuyOut, fee, sqrtPriceLimitX96: 0,
          }).then((r: any) => r[0] as bigint).catch(() => 0n);
        })),
      ]);

      const bestUniSell    = uniSellRaw.reduce((a, b) => b > a ? b : a, 0n);
      const bestUniSellFee = UNI_FEES[uniSellRaw.indexOf(bestUniSell)] ?? 3000;

      const sellOnAero = aeroSellOut > bestUniSell && aeroSellOut > 0n;
      const bestSellOut = sellOnAero ? aeroSellOut : bestUniSell;
      const bestSellDex = sellOnAero ? 'aerodrome' : `uni-v3@${bestUniSellFee}`;

      if (bestSellOut === 0n) return null;

      // Reject same-DEX round-trips (no cross-DEX edge — already covered by dexSpreadSignal)
      if (bestBuyDex.startsWith('uni-v3') && bestSellDex.startsWith('uni-v3')) return null;
      if (bestBuyDex === 'aerodrome' && bestSellDex === 'aerodrome') return null;

      const spreadBps = loanAmount > 0n
        ? Number(((bestSellOut - loanAmount) * 10_000n) / loanAmount)
        : 0;

      const isOpportunity = spreadBps >= CONFIG.MIN_PROFIT_BPS;

      const hash = opportunityHash({
        chainId:      CONFIG.CHAIN_ID,
        blockNumber,
        strategyId:   'apex.aerodrome_spread',
        feeTier:      0,
        tokenIn:      pair.tokenIn,
        tokenOut:     pair.tokenOut,
        quotedInput:  loanAmount.toString(),
        quotedOutput: bestSellOut.toString(),
      });

      logger.debug('AERO',
        `${pair.name} spread=${spreadBps}bps buy=${bestBuyDex} sell=${bestSellDex}`
      );

      const grossUsd = Math.max(0, usdcToUsd(bestSellOut - loanAmount));

      const opp: Opportunity = {
        timestamp:        new Date().toISOString(),
        blockNumber,
        chainId:          CONFIG.CHAIN_ID,
        botId:            CONFIG.BOT_ID,
        runId:            CONFIG.RUN_ID,
        strategyId:       'apex.aerodrome_spread',
        opportunityHash:  hash,
        tokenIn:          pair.tokenIn,
        tokenOut:         pair.tokenOut,
        route:            `${pair.name} (buy=${bestBuyDex} sell=${bestSellDex})`,
        dex:              'aerodrome↔uni-v3',
        feeTier:          0,
        quotedInput:      loanAmount.toString(),
        quotedOutput:     bestSellOut.toString(),
        fairValuePrice:   null,
        dexPrice:         Number(bestSellOut) / Number(loanAmount),
        cexPrice:         null,
        spreadBps,
        grossProfitUsd:   grossUsd,
        netProfitUsd:     parseFloat(Math.max(0, grossUsd - 0.90 - grossUsd * 0.0005).toFixed(4)),
        gasEstimate:      '0.0003',
        slippageEstimate: Math.min(250, Math.round(Math.sqrt(Number(loanAmount) / 1e12) * 10)),
        flashLoanFeeEst:  0,
        builderFeeEst:    0,
        confidenceScore:  Math.min(100, Math.round(spreadBps * 2)),
        rejectionReason:  isOpportunity ? null : `Spread ${spreadBps}bps below ${CONFIG.MIN_PROFIT_BPS}bps`,
        safetyDecision:   'dry_run_only',
        dryRunOnly:       true,
        liveEligible:     false,
      };

      return {
        pair:        pair.name,
        tokenIn:     pair.tokenIn,
        tokenOut:    pair.tokenOut,
        buyDex:      bestBuyDex,
        sellDex:     bestSellDex,
        spreadBps,
        loanAmount,
        grossProfit: bestSellOut > loanAmount ? bestSellOut - loanAmount : 0n,
        opportunity: isOpportunity ? opp : null,
      };
    } catch (err: any) {
      logger.debug('AERO', `${pair.name} scan error: ${err.message}`);
      return null;
    }
  }
}
