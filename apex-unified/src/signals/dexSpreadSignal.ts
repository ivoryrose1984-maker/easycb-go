import { ethers } from 'ethers';
import CONFIG, { usdcToUsd } from '../core/config';
import { Opportunity } from '../types/Opportunity';
import { opportunityHash } from '../core/dedup';
import { logger } from '../core/logger';
import { logRejection } from '../core/jsonlLogger';
import { ternarySearchSize } from '../execution/flashLoanPlanner';
import { rpcHealth } from '../core/rpcHealth';
import { isPoolValid } from '../core/startupValidator';

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160,uint32,uint256)',
];

const UNI_FEES  = [100, 500, 3000, 10000];
const CAKE_FEES = [100, 500, 2500, 10000];  // PancakeSwap V3 uses 2500 not 3000

// Liquidity depth constants come from CONFIG so they are tunable via .env
// LIQUIDITY_CHECK_SCALE:    re-quote at N× loan size (default 10)
// LIQUIDITY_MAX_IMPACT_BPS: reject if price degrades > this many bps at N× (default 5000 = 50%)

type DexId = 'uni-v3' | 'cake-v3';

interface QuoteCandidate { dex: DexId; fee: number; out: bigint; }

export interface DexSpreadResult {
  pair:            string;
  tokenIn:         string;
  tokenOut:        string;
  buyDex:          DexId;
  buyFee:          number;
  sellDex:         DexId;
  sellFee:         number;
  spreadBps:       number;
  loanAmount:      bigint;
  grossProfit:     bigint;
  rejectionReason: string | null;
  opportunity:     Opportunity | null;
  // Size-search bounds (populated when size search runs)
  chosenSizeLo?:   string;
  chosenSizeHi?:   string;
}

export class DexSpreadSignal {
  private uniQuoter:  ethers.Contract;
  private cakeQuoter: ethers.Contract;

  constructor(provider: ethers.Provider) {
    this.uniQuoter  = new ethers.Contract(CONFIG.CONTRACTS.UNI_QUOTER,  QUOTER_ABI, provider);
    this.cakeQuoter = new ethers.Contract(CONFIG.CONTRACTS.CAKE_QUOTER, QUOTER_ABI, provider);
  }

  // ── Size search ───────────────────────────────────────────────────────────────────

  private async sizeSearch(
    pair:     { tokenIn: string; tokenOut: string },
    bestBuy:  QuoteCandidate,
    bestSell: QuoteCandidate,
    isWethIn: boolean,
    isDaiIn:  boolean,
  ): Promise<{ optimalAmount: bigint; lo: bigint; hi: bigint }> {
    const lo = isWethIn ? CONFIG.MIN_LOAN_WETH
             : isDaiIn  ? CONFIG.MIN_LOAN_DAI
             : CONFIG.MIN_LOAN_USDC;
    const hi = isWethIn ? CONFIG.MAX_LOAN_WETH
             : isDaiIn  ? CONFIG.MAX_LOAN_DAI
             : CONFIG.MAX_LOAN_USDC;

    const buyQ  = bestBuy.dex  === 'uni-v3' ? this.uniQuoter  : this.cakeQuoter;
    const sellQ = bestSell.dex === 'uni-v3' ? this.uniQuoter  : this.cakeQuoter;

    const grossAt = async (size: bigint): Promise<bigint> => {
      const buyOut = await buyQ.quoteExactInputSingle.staticCall({
        tokenIn: pair.tokenIn, tokenOut: pair.tokenOut,
        amountIn: size, fee: bestBuy.fee, sqrtPriceLimitX96: 0,
      }).then((r: any) => r[0] as bigint).catch(() => 0n);
      if (buyOut === 0n) return 0n;
      const sellOut = await sellQ.quoteExactInputSingle.staticCall({
        tokenIn: pair.tokenOut, tokenOut: pair.tokenIn,
        amountIn: buyOut, fee: bestSell.fee, sqrtPriceLimitX96: 0,
      }).then((r: any) => r[0] as bigint).catch(() => 0n);
      return sellOut > size ? sellOut - size : 0n;
    };

    const optimalAmount = await ternarySearchSize(grossAt, lo, hi);
    return { optimalAmount, lo, hi };
  }

  // ── Main scan ─────────────────────────────────────────────────────────────────────

  async scan(
    pair:        { tokenIn: string; tokenOut: string; name: string },
    loanAmount:  bigint,
    blockNumber: number,
    ethPriceUsd: bigint
  ): Promise<DexSpreadResult | null> {
    // Skip when RPC is throttled (429) — reduces CU burn during rate-limit window
    if (rpcHealth.shouldSkipNonCritical()) return null;

    try {
      // ── Phase 1: buy quotes tokenIn → tokenOut (both DEXes, confirmed fee tiers only) ──
      const [uniBuyRaw, cakeBuyRaw] = await Promise.all([
        Promise.all(UNI_FEES.map(fee =>
          !isPoolValid('uni-v3', fee, pair.tokenIn, pair.tokenOut) ? Promise.resolve(0n) :
          this.uniQuoter.quoteExactInputSingle.staticCall({
            tokenIn: pair.tokenIn, tokenOut: pair.tokenOut,
            amountIn: loanAmount, fee, sqrtPriceLimitX96: 0,
          }).then((r: any) => r[0] as bigint).catch(() => 0n)
        )),
        Promise.all(CAKE_FEES.map(fee =>
          !isPoolValid('cake-v3', fee, pair.tokenIn, pair.tokenOut) ? Promise.resolve(0n) :
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
          if (!isPoolValid('uni-v3', fee, pair.tokenIn, pair.tokenOut)) return Promise.resolve(0n);
          return this.uniQuoter.quoteExactInputSingle.staticCall({
            tokenIn: pair.tokenOut, tokenOut: pair.tokenIn,
            amountIn: bestBuy.out, fee, sqrtPriceLimitX96: 0,
          }).then((r: any) => r[0] as bigint).catch(() => 0n);
        })),
        Promise.all(CAKE_FEES.map(fee => {
          if (bestBuy.dex === 'cake-v3' && fee === bestBuy.fee) return Promise.resolve(0n);
          if (!isPoolValid('cake-v3', fee, pair.tokenIn, pair.tokenOut)) return Promise.resolve(0n);
          return this.cakeQuoter.quoteExactInputSingle.staticCall({
            tokenIn: pair.tokenOut, tokenOut: pair.tokenIn,
            amountIn: bestBuy.out, fee, sqrtPriceLimitX96: 0,
          }).then((r: any) => r[0] as bigint).catch(() => 0n);
        })),
      ]);

      // Floor: reject sell quotes returning < 50% of loanAmount.
      // Prevents dust-winning races where the deep pool times out and a thin
      // pool returns near-zero, producing fake -9000bps spreads that pollute
      // the anomaly log and bias the capture-rate metric.
      const sellFloor = loanAmount / 2n;
      const sellQuotes: QuoteCandidate[] = [
        ...UNI_FEES.map((fee, i)  => ({ dex: 'uni-v3'  as DexId, fee, out: uniSellRaw[i] })),
        ...CAKE_FEES.map((fee, i) => ({ dex: 'cake-v3' as DexId, fee, out: cakeSellRaw[i] })),
      ].filter(q => q.out >= sellFloor);

      if (sellQuotes.length === 0) return null;
      const bestSell = sellQuotes.reduce((a, b) => b.out > a.out ? b : a);

      // Phase 3: reject cross-fee-tier same-DEX if buy and sell are on the same DEX
      // (different fee tiers of the same DEX produce persistent phantom spreads due to
      // thin or absent pools at exotic fee tiers — confirmed by frozen 95bps DAI/WETH).
      const isCrossDex = bestBuy.dex !== bestSell.dex;
      if (!isCrossDex) {
        // Same DEX: only allow if cross-fee-tier spread is plausible — apply strict
        // liquidity check on BOTH legs before counting as opportunity.
        // (Cross-DEX arb is allowed; same-DEX same-tier was already blocked in Phase 2.)
      }

      const spreadBpsProbe = loanAmount > 0n
        ? Number(((bestSell.out - loanAmount) * 10_000n) / loanAmount)
        : 0;

      // BUG-01: anomaly gate — |spread| > 2000bps indicates empty/thin pool or decimal
      // mismatch, not a real market opportunity. Tag as "anomaly" (not "skip") so skip
      // stats remain clean. Skip expensive liquidity check and size search.
      if (Math.abs(spreadBpsProbe) > 2000) {
        logger.warn('DEX', `${pair.name} unit anomaly: spread=${spreadBpsProbe}bps — thin pool or no liquidity`);
        logRejection({ strategyId: 'apex.dex_spread', blockNumber, pair: pair.name, spreadBps: spreadBpsProbe, reason: 'unit_anomaly' });
        return {
          pair:            pair.name,
          tokenIn:         pair.tokenIn,
          tokenOut:        pair.tokenOut,
          buyDex:          bestBuy.dex,
          buyFee:          bestBuy.fee,
          sellDex:         bestSell.dex,
          sellFee:         bestSell.fee,
          spreadBps:       spreadBpsProbe,
          loanAmount,
          grossProfit:     0n,
          rejectionReason: `unit_anomaly: spread=${spreadBpsProbe}bps`,
          opportunity:     null,
        };
      }

      const dexLabel = isCrossDex
        ? `${bestBuy.dex}→${bestSell.dex}`
        : bestBuy.dex;

      const isOpportunity = spreadBpsProbe >= CONFIG.MIN_PROFIT_BPS;

      // Phase 4: liquidity depth check — run on BOTH buy AND sell legs in parallel.
      // Checks at LIQUIDITY_CHECK_SCALE× to catch thin pools.
      // Sell leg check fixes the DAI/WETH cake-v3@500→cake-v3@100 phantom where the
      // buy-only check passed but the sell pool (100bps) had no real liquidity.
      let thinPool  = false;
      let impactBps = 0;
      const scale   = BigInt(CONFIG.LIQUIDITY_CHECK_SCALE);

      if (isOpportunity) {
        const buyQ  = bestBuy.dex  === 'uni-v3' ? this.uniQuoter  : this.cakeQuoter;
        const sellQ = bestSell.dex === 'uni-v3' ? this.uniQuoter  : this.cakeQuoter;

        const [scaledBuyOut, scaledSellOut] = await Promise.all([
          buyQ.quoteExactInputSingle.staticCall({
            tokenIn: pair.tokenIn, tokenOut: pair.tokenOut,
            amountIn: loanAmount * scale, fee: bestBuy.fee, sqrtPriceLimitX96: 0,
          }).then((r: any) => r[0] as bigint).catch(() => 0n),
          sellQ.quoteExactInputSingle.staticCall({
            tokenIn: pair.tokenOut, tokenOut: pair.tokenIn,
            amountIn: bestBuy.out * scale, fee: bestSell.fee, sqrtPriceLimitX96: 0,
          }).then((r: any) => r[0] as bigint).catch(() => 0n),
        ]);

        const buyImpact  = scaledBuyOut > 0n
          ? Number((bestBuy.out * scale - scaledBuyOut)  * 10_000n / (bestBuy.out  * scale))
          : 10_000;
        const sellImpact = scaledSellOut > 0n
          ? Number((bestSell.out * scale - scaledSellOut) * 10_000n / (bestSell.out * scale))
          : 10_000;

        impactBps = Math.max(buyImpact, sellImpact);
        thinPool  = impactBps > CONFIG.LIQUIDITY_MAX_IMPACT_BPS;

        if (thinPool) {
          logger.debug('DEX',
            `${pair.name} thin-pool: buy=${buyImpact}bps sell=${sellImpact}bps ` +
            `(${CONFIG.LIQUIDITY_CHECK_SCALE}× check) — skip`
          );
        }
      }

      // Phase 5: size search — find optimal loan amount via 8-iteration ternary search.
      // Only runs when both legs pass the liquidity gate (rare — ~1% of pairs/block).
      let finalLoan   = loanAmount;
      let finalBuyOut = bestBuy.out;
      let finalSellOut = bestSell.out;
      let sizeLo: string | undefined;
      let sizeHi: string | undefined;

      if (isOpportunity && !thinPool) {
        const isWethIn = pair.tokenIn.toLowerCase() === CONFIG.TOKENS.WETH.toLowerCase();
        const isDaiIn  = pair.tokenIn.toLowerCase() === CONFIG.TOKENS.DAI.toLowerCase();
        const { optimalAmount, lo, hi } = await this.sizeSearch(pair, bestBuy, bestSell, isWethIn, isDaiIn);

        // Re-quote at optimal size to get accurate final output
        const buyQ  = bestBuy.dex  === 'uni-v3' ? this.uniQuoter  : this.cakeQuoter;
        const sellQ = bestSell.dex === 'uni-v3' ? this.uniQuoter  : this.cakeQuoter;
        const optBuyOut = await buyQ.quoteExactInputSingle.staticCall({
          tokenIn: pair.tokenIn, tokenOut: pair.tokenOut,
          amountIn: optimalAmount, fee: bestBuy.fee, sqrtPriceLimitX96: 0,
        }).then((r: any) => r[0] as bigint).catch(() => 0n);

        if (optBuyOut > 0n) {
          const optSellOut = await sellQ.quoteExactInputSingle.staticCall({
            tokenIn: pair.tokenOut, tokenOut: pair.tokenIn,
            amountIn: optBuyOut, fee: bestSell.fee, sqrtPriceLimitX96: 0,
          }).then((r: any) => r[0] as bigint).catch(() => 0n);

          if (optSellOut > 0n) {
            finalLoan    = optimalAmount;
            finalBuyOut  = optBuyOut;
            finalSellOut = optSellOut;
          }
        }
        sizeLo = lo.toString();
        sizeHi = hi.toString();
      }

      // Recompute spread at final (possibly optimal) size
      const spreadBps = finalLoan > 0n
        ? Number(((finalSellOut - finalLoan) * 10_000n) / finalLoan)
        : spreadBpsProbe;

      logger.debug('DEX',
        `${pair.name} spread=${spreadBps}bps buy=${bestBuy.dex}@${bestBuy.fee} sell=${bestSell.dex}@${bestSell.fee}` +
        (sizeLo ? ` size=${finalLoan}` : '')
      );

      const isWethIn       = pair.tokenIn.toLowerCase() === CONFIG.TOKENS.WETH.toLowerCase();
      const isDaiIn        = pair.tokenIn.toLowerCase() === CONFIG.TOKENS.DAI.toLowerCase();
      const grossProfitRaw = finalSellOut > finalLoan ? finalSellOut - finalLoan : 0n;
      // DAI is 18-dec ~$1; divide by 1e18. WETH is 18-dec; use eth price. Others are 6-dec USDC.
      const grossUsd       = isWethIn
        ? Math.max(0, usdcToUsd(grossProfitRaw * ethPriceUsd / 10n ** 18n))
        : isDaiIn
          ? Math.max(0, Number(grossProfitRaw) / 1e18)
          : Math.max(0, usdcToUsd(grossProfitRaw));
      const gasUsd         = 0.0003 * (Number(ethPriceUsd) / 1e6);

      const hash = opportunityHash({
        chainId:      CONFIG.CHAIN_ID,
        strategyId:   'apex.dex_spread',
        feeTier:      bestBuy.fee,
        tokenIn:      pair.tokenIn,
        tokenOut:     pair.tokenOut,
        quotedInput:  finalLoan.toString(),
        quotedOutput: finalSellOut.toString(),
      });

      const finalIsOpportunity = spreadBps >= CONFIG.MIN_PROFIT_BPS && !thinPool;

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
        quotedInput:      finalLoan.toString(),
        quotedOutput:     finalSellOut.toString(),
        fairValuePrice:   null,
        dexPrice:         Number(finalSellOut) / Number(finalLoan),
        cexPrice:         null,
        spreadBps,
        grossProfitUsd:   grossUsd,
        netProfitUsd:     parseFloat(Math.max(0, grossUsd - gasUsd - grossUsd * (CONFIG.FLASH_LOAN_FEE_BPS / 10_000)).toFixed(4)),
        gasEstimate:      '0.0003',
        slippageEstimate: Math.min(250, Math.round(Math.sqrt(Number(finalLoan) / 1e12) * 10)),
        flashLoanFeeEst:  0,
        builderFeeEst:    0,
        confidenceScore:  Math.min(100, Math.round(spreadBps * 2)),
        rejectionReason:  !finalIsOpportunity
          ? thinPool
            ? `thin_pool: ${CONFIG.LIQUIDITY_CHECK_SCALE}x_impact=${impactBps}bps > ${CONFIG.LIQUIDITY_MAX_IMPACT_BPS}bps`
            : `spread_below_threshold: ${spreadBps}bps < ${CONFIG.MIN_PROFIT_BPS}bps`
          : null,
        safetyDecision:   'dry_run_only',
        dryRunOnly:       true,
        liveEligible:     false,
      };

      const finalOpportunity = finalIsOpportunity ? opp : null;
      const rejReason = opp.rejectionReason;

      if (rejReason) {
        logRejection({ strategyId: 'apex.dex_spread', blockNumber, pair: pair.name, spreadBps, reason: rejReason });
      }

      return {
        pair:            pair.name,
        tokenIn:         pair.tokenIn,
        tokenOut:        pair.tokenOut,
        buyDex:          bestBuy.dex,
        buyFee:          bestBuy.fee,
        sellDex:         bestSell.dex,
        sellFee:         bestSell.fee,
        spreadBps,
        loanAmount:      finalLoan,
        grossProfit:     grossProfitRaw,
        rejectionReason: rejReason,
        opportunity:     finalOpportunity,
        chosenSizeLo:    sizeLo,
        chosenSizeHi:    sizeHi,
      };
    } catch (err: any) {
      logger.debug('DEX', `${pair.name} scan error: ${err.message}`);
      return null;
    }
  }
}
