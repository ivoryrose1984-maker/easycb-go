import { ethers } from 'ethers';
import CONFIG, { usdcToUsd } from '../core/config';
import { Opportunity } from '../types/Opportunity';
import { opportunityHash } from '../core/dedup';
import { logger } from '../core/logger';

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160,uint32,uint256)',
];

const UNI_FEES  = [100, 500, 3000, 10000];
const CAKE_FEES = [100, 500, 2500, 10000];  // PancakeSwap V3 uses 2500 not 3000

type DexId = 'uni-v3' | 'cake-v3';

interface QuoteCandidate { dex: DexId; fee: number; out: bigint; }

export interface DexSpreadResult {
  pair:        string;
  tokenIn:     string;
  tokenOut:    string;
  buyDex:      DexId;
  buyFee:      number;
  sellDex:     DexId;
  sellFee:     number;
  spreadBps:   number;
  loanAmount:  bigint;
  grossProfit: bigint;
  opportunity: Opportunity | null;
}

export class DexSpreadSignal {
  private uniQuoter:  ethers.Contract;
  private cakeQuoter: ethers.Contract;

  constructor(provider: ethers.Provider) {
    this.uniQuoter  = new ethers.Contract(CONFIG.CONTRACTS.UNI_QUOTER,  QUOTER_ABI, provider);
    this.cakeQuoter = new ethers.Contract(CONFIG.CONTRACTS.CAKE_QUOTER, QUOTER_ABI, provider);
  }

  async scan(
    pair:        { tokenIn: string; tokenOut: string; name: string },
    loanAmount:  bigint,
    blockNumber: number,
    ethPriceUsd: bigint
  ): Promise<DexSpreadResult | null> {
    try {
      // ── Phase 1: buy quotes tokenIn → tokenOut (both DEXes, all fee tiers) ──
      const [uniBuyRaw, cakeBuyRaw] = await Promise.all([
        Promise.all(UNI_FEES.map(fee =>
          this.uniQuoter.quoteExactInputSingle.staticCall({
            tokenIn: pair.tokenIn, tokenOut: pair.tokenOut,
            amountIn: loanAmount, fee, sqrtPriceLimitX96: 0,
          }).then((r: any) => r[0] as bigint).catch(() => 0n)
        )),
        Promise.all(CAKE_FEES.map(fee =>
          this.cakeQuoter.quoteExactInputSingle.staticCall({
            tokenIn: pair.tokenIn, tokenOut: pair.tokenOut,
            amountIn: loanAmount, fee, sqrtPriceLimitX96: 0,
          }).then((r: any) => r[0] as bigint).catch(() => 0n)
        )),
      ]);

      const buyQuotes: QuoteCandidate[] = [
        ...UNI_FEES.map((fee, i)  => ({ dex: 'uni-v3'  as DexId, fee, out: uniBuyRaw[i] })),
        ...CAKE_FEES.map((fee, i) => ({ dex: 'cake-v3' as DexId, fee, out: cakeBuyRaw[i] })),
      ].filter(q => q.out > 0n);

      if (buyQuotes.length === 0) return null;
      const bestBuy = buyQuotes.reduce((a, b) => b.out > a.out ? b : a);

      // ── Phase 2: sell quotes tokenOut → tokenIn (skip same pool as buy) ──
      const [uniSellRaw, cakeSellRaw] = await Promise.all([
        Promise.all(UNI_FEES.map(fee => {
          if (bestBuy.dex === 'uni-v3' && fee === bestBuy.fee) return Promise.resolve(0n);
          return this.uniQuoter.quoteExactInputSingle.staticCall({
            tokenIn: pair.tokenOut, tokenOut: pair.tokenIn,
            amountIn: bestBuy.out, fee, sqrtPriceLimitX96: 0,
          }).then((r: any) => r[0] as bigint).catch(() => 0n);
        })),
        Promise.all(CAKE_FEES.map(fee => {
          if (bestBuy.dex === 'cake-v3' && fee === bestBuy.fee) return Promise.resolve(0n);
          return this.cakeQuoter.quoteExactInputSingle.staticCall({
            tokenIn: pair.tokenOut, tokenOut: pair.tokenIn,
            amountIn: bestBuy.out, fee, sqrtPriceLimitX96: 0,
          }).then((r: any) => r[0] as bigint).catch(() => 0n);
        })),
      ]);

      const sellQuotes: QuoteCandidate[] = [
        ...UNI_FEES.map((fee, i)  => ({ dex: 'uni-v3'  as DexId, fee, out: uniSellRaw[i] })),
        ...CAKE_FEES.map((fee, i) => ({ dex: 'cake-v3' as DexId, fee, out: cakeSellRaw[i] })),
      ].filter(q => q.out > 0n);

      if (sellQuotes.length === 0) return null;
      const bestSell = sellQuotes.reduce((a, b) => b.out > a.out ? b : a);

      const spreadBps = loanAmount > 0n
        ? Number(((bestSell.out - loanAmount) * 10_000n) / loanAmount)
        : 0;

      const isCrossDex  = bestBuy.dex !== bestSell.dex;
      const dexLabel    = isCrossDex
        ? `${bestBuy.dex}→${bestSell.dex}`
        : bestBuy.dex;

      const isOpportunity = spreadBps >= CONFIG.MIN_PROFIT_BPS;

      const hash = opportunityHash({
        chainId:      CONFIG.CHAIN_ID,
        blockNumber,
        strategyId:   'apex.dex_spread',
        feeTier:      bestBuy.fee,
        tokenIn:      pair.tokenIn,
        tokenOut:     pair.tokenOut,
        quotedInput:  loanAmount.toString(),
        quotedOutput: bestSell.out.toString(),
      });

      logger.debug('DEX',
        `${pair.name} spread=${spreadBps}bps buy=${bestBuy.dex}@${bestBuy.fee} sell=${bestSell.dex}@${bestSell.fee}`
      );

      const grossProfitRaw = bestSell.out > loanAmount ? bestSell.out - loanAmount : 0n;
      const isWethIn = pair.tokenIn.toLowerCase() === CONFIG.TOKENS.WETH.toLowerCase();
      // WETH profit is 18-dec; convert via eth price before usdcToUsd (which divides by 1e6)
      const grossUsd = isWethIn
        ? Math.max(0, usdcToUsd(grossProfitRaw * ethPriceUsd / 10n ** 18n))
        : Math.max(0, usdcToUsd(grossProfitRaw));
      const gasUsd = 0.0003 * (Number(ethPriceUsd) / 1e6);

      const opp: Opportunity = {
        timestamp:        new Date().toISOString(),
        blockNumber,
        chainId:          CONFIG.CHAIN_ID,
        botId:            CONFIG.BOT_ID,
        runId:            CONFIG.RUN_ID,
        strategyId:       'apex.dex_spread',
        opportunityHash:  hash,
        tokenIn:          pair.tokenIn,
        tokenOut:         pair.tokenOut,
        route:            `${pair.name} (buy=${bestBuy.dex}@${bestBuy.fee} sell=${bestSell.dex}@${bestSell.fee})`,
        dex:              dexLabel,
        feeTier:          bestBuy.fee,
        quotedInput:      loanAmount.toString(),
        quotedOutput:     bestSell.out.toString(),
        fairValuePrice:   null,
        dexPrice:         Number(bestSell.out) / Number(loanAmount),
        cexPrice:         null,
        spreadBps,
        grossProfitUsd:   grossUsd,
        netProfitUsd:     parseFloat(Math.max(0, grossUsd - gasUsd - grossUsd * 0.001).toFixed(4)),
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
        buyDex:      bestBuy.dex,
        buyFee:      bestBuy.fee,
        sellDex:     bestSell.dex,
        sellFee:     bestSell.fee,
        spreadBps,
        loanAmount,
        grossProfit: grossProfitRaw,
        opportunity: isOpportunity ? opp : null,
      };
    } catch (err: any) {
      logger.debug('DEX', `${pair.name} scan error: ${err.message}`);
      return null;
    }
  }
}
