import { ethers } from 'ethers';
import CONFIG, { usdcToUsd } from '../core/config';
import { Opportunity } from '../types/Opportunity';
import { opportunityHash } from '../core/dedup';
import { logger } from '../core/logger';

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160,uint32,uint256)',
];

const FEE_TIERS = [100, 500, 3000, 10000];

export interface DexSpreadResult {
  pair:         string;
  tokenIn:      string;
  tokenOut:     string;
  buyFee:       number;
  sellFee:      number;
  spreadBps:    number;
  loanAmount:   bigint;
  grossProfit:  bigint;
  opportunity:  Opportunity | null;
}

export class DexSpreadSignal {
  private quoter: ethers.Contract;

  constructor(provider: ethers.Provider) {
    this.quoter = new ethers.Contract(CONFIG.CONTRACTS.UNI_QUOTER, QUOTER_ABI, provider);
  }

  async scan(
    pair:        { tokenIn: string; tokenOut: string; name: string },
    loanAmount:  bigint,
    blockNumber: number,
    ethPriceUsd: bigint
  ): Promise<DexSpreadResult | null> {
    try {
      const buyQuotes = await Promise.all(FEE_TIERS.map(fee =>
        this.quoter.quoteExactInputSingle.staticCall({
          tokenIn: pair.tokenIn, tokenOut: pair.tokenOut,
          amountIn: loanAmount, fee, sqrtPriceLimitX96: 0,
        }).catch(() => null)
      ));

      let buyFee = FEE_TIERS[0], bestBuyOut = 0n;
      for (let i = 0; i < FEE_TIERS.length; i++) {
        const out: bigint = buyQuotes[i]?.[0] ?? 0n;
        if (out > bestBuyOut) { bestBuyOut = out; buyFee = FEE_TIERS[i]; }
      }
      if (bestBuyOut === 0n) return null;

      const sellFeeTiers = FEE_TIERS.filter(f => f !== buyFee);
      const sellQuotes = await Promise.all(sellFeeTiers.map(fee =>
        this.quoter.quoteExactInputSingle.staticCall({
          tokenIn: pair.tokenOut, tokenOut: pair.tokenIn,
          amountIn: bestBuyOut, fee, sqrtPriceLimitX96: 0,
        }).catch(() => null)
      ));

      let sellFee = sellFeeTiers[0], bestSellOut = 0n;
      for (let i = 0; i < sellFeeTiers.length; i++) {
        const out: bigint = sellQuotes[i]?.[0] ?? 0n;
        if (out > bestSellOut) { bestSellOut = out; sellFee = sellFeeTiers[i]; }
      }
      if (bestSellOut === 0n) return null;

      const spreadBps = loanAmount > 0n
        ? Number(((bestSellOut - loanAmount) * 10_000n) / loanAmount)
        : 0;

      const isOpportunity = spreadBps >= CONFIG.MIN_PROFIT_BPS;

      const hash = opportunityHash({
        chainId:      CONFIG.CHAIN_ID,
        blockNumber,
        strategyId:   'apex.dex_spread',
        feeTier:      buyFee,
        tokenIn:      pair.tokenIn,
        tokenOut:     pair.tokenOut,
        quotedInput:  loanAmount.toString(),
        quotedOutput: bestSellOut.toString(),
      });

      logger.debug('DEX', `${pair.name} spread=${spreadBps}bps buy=${buyFee} sell=${sellFee}`);

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
        route:            `${pair.name} (buy=${buyFee} sell=${sellFee})`,
        dex:              'uniswap-v3',
        feeTier:          buyFee,
        quotedInput:      loanAmount.toString(),
        quotedOutput:     bestSellOut.toString(),
        fairValuePrice:   null,
        dexPrice:         Number(bestSellOut) / Number(loanAmount),
        cexPrice:         null,
        spreadBps,
        grossProfitUsd:   usdcToUsd(bestSellOut - loanAmount),
        netProfitUsd:     0,
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
        buyFee,
        sellFee,
        spreadBps,
        loanAmount,
        grossProfit: bestSellOut > loanAmount ? bestSellOut - loanAmount : 0n,
        opportunity: isOpportunity ? opp : null,
      };
    } catch (err: any) {
      logger.debug('DEX', `${pair.name} scan error: ${err.message}`);
      return null;
    }
  }
}
