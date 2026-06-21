import { ethers } from 'ethers';
import CONFIG, { usdcToUsd } from '../core/config';
import { Opportunity } from '../types/Opportunity';
import { opportunityHash } from '../core/dedup';
import { logger } from '../core/logger';
import { getAmountOutStable, getAmountOutVolatile } from '../execution/solidlyMath';

// Direct pool reads — bypasses V1/V2 router ABI mismatch entirely.
// V2 router (0xcF77a…) uses (from,to,stable,factory) struct; V1 uses (from,to,stable).
// Fetching reserves directly and computing off-chain avoids the mismatch.
const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, bool stable) view returns (address)',
];

const POOL_ABI = [
  'function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)',
  'function token0() view returns (address)',
];

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160,uint32,uint256)',
];

const UNI_FEES  = [100, 500, 3000, 10000];
const CAKE_FEES = [100, 500, 2500, 10000];  // PancakeSwap V3: 2500 replaces 3000

// Stable pool: 0.05% default; volatile: 0.3% default (Aerodrome V2 standard)
const STABLE_FEE_BPS   = 5n;
const VOLATILE_FEE_BPS = 30n;

// Hardcoded — no RPC needed for token decimal lookup
const TOKEN_DECIMALS: Record<string, number> = {
  [CONFIG.TOKENS.USDC.toLowerCase()]:  6,
  [CONFIG.TOKENS.USDbC.toLowerCase()]: 6,
  [CONFIG.TOKENS.USDT.toLowerCase()]:  6,
  [CONFIG.TOKENS.DAI.toLowerCase()]:   18,
  [CONFIG.TOKENS.WETH.toLowerCase()]:  18,
  [CONFIG.TOKENS.cbETH.toLowerCase()]: 18,
  [CONFIG.TOKENS.AERO.toLowerCase()]:  18,
};

// |spread| > 2000bps = anomaly (stale reserves, thin pool, data artifact — not real arb)
const ANOMALY_THRESHOLD_BPS = 2_000;

export interface AerodromeSpreadResult {
  pair:         string;
  tokenIn:      string;
  tokenOut:     string;
  buyDex:       string;
  sellDex:      string;
  spreadBps:    number;
  loanAmount:   bigint;
  grossProfit:  bigint;
  opportunity:  Opportunity | null;
  filterResult: 'pass' | 'skip' | 'anomaly';
}

export class AerodromeSignal {
  private readonly factory:    ethers.Contract;
  private readonly uniQuoter:  ethers.Contract;
  private readonly cakeQuoter: ethers.Contract;
  private readonly provider:   ethers.Provider;

  // Pool address cache — factory calls are stable; no need to re-fetch each block.
  private readonly poolCache = new Map<string, string>();

  constructor(provider: ethers.Provider) {
    this.provider    = provider;
    this.factory     = new ethers.Contract(CONFIG.CONTRACTS.AERODROME_FACTORY, FACTORY_ABI,  provider);
    this.uniQuoter   = new ethers.Contract(CONFIG.CONTRACTS.UNI_QUOTER,        QUOTER_ABI,   provider);
    this.cakeQuoter  = new ethers.Contract(CONFIG.CONTRACTS.CAKE_QUOTER,       QUOTER_ABI,   provider);
  }

  private async getPoolAddress(tokenA: string, tokenB: string, stable: boolean): Promise<string | null> {
    const key = `${tokenA.toLowerCase()}:${tokenB.toLowerCase()}:${stable}`;
    const cached = this.poolCache.get(key);
    if (cached) return cached;
    try {
      const addr = await this.factory.getPool(tokenA, tokenB, stable) as string;
      if (!addr || addr === ethers.ZeroAddress) return null;
      this.poolCache.set(key, addr);
      return addr;
    } catch {
      return null;
    }
  }

  private async getAeroQuote(
    tokenIn:  string,
    tokenOut: string,
    stable:   boolean,
    amountIn: bigint,
  ): Promise<bigint> {
    const poolAddr = await this.getPoolAddress(tokenIn, tokenOut, stable);
    if (!poolAddr) return 0n;

    try {
      const pool = new ethers.Contract(poolAddr, POOL_ABI, this.provider);
      const [[r0, r1], tok0] = await Promise.all([
        pool.getReserves() as Promise<[bigint, bigint, bigint]>,
        pool.token0()      as Promise<string>,
      ]);

      const isToken0In = tokenIn.toLowerCase() === tok0.toLowerCase();
      const reserveIn  = isToken0In ? r0 : r1;
      const reserveOut = isToken0In ? r1 : r0;

      if (stable) {
        const decIn  = TOKEN_DECIMALS[tokenIn.toLowerCase()]  ?? 18;
        const decOut = TOKEN_DECIMALS[tokenOut.toLowerCase()] ?? 18;
        return getAmountOutStable(amountIn, reserveIn, reserveOut, decIn, decOut, STABLE_FEE_BPS);
      }
      return getAmountOutVolatile(amountIn, reserveIn, reserveOut, VOLATILE_FEE_BPS);
    } catch {
      return 0n;
    }
  }

  async scan(
    pair:        { tokenIn: string; tokenOut: string; name: string; stable: boolean },
    loanAmount:  bigint,
    blockNumber: number,
    ethPriceUsd: bigint = 3_000_000_000n,
  ): Promise<AerodromeSpreadResult | null> {
    try {
      // ── Buy leg: tokenIn → tokenOut (Aerodrome + Uni V3 + PancakeSwap V3) ──
      const [aeroBuyOut, uniBuyRaw, cakeBuyRaw] = await Promise.all([
        this.getAeroQuote(pair.tokenIn, pair.tokenOut, pair.stable, loanAmount),
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

      const bestUniBuy    = uniBuyRaw.reduce((a, b) => b > a ? b : a, 0n);
      const bestUniBuyFee = UNI_FEES[uniBuyRaw.indexOf(bestUniBuy)] ?? 3000;
      const bestCakeBuy   = cakeBuyRaw.reduce((a, b) => b > a ? b : a, 0n);
      const bestCakeBuyFee = CAKE_FEES[cakeBuyRaw.indexOf(bestCakeBuy)] ?? 2500;

      const bestCexBuy    = bestUniBuy > bestCakeBuy ? bestUniBuy : bestCakeBuy;
      const bestCexBuyDex = bestUniBuy > bestCakeBuy ? `uni-v3@${bestUniBuyFee}` : `cake-v3@${bestCakeBuyFee}`;

      const buyOnAero  = aeroBuyOut > bestCexBuy && aeroBuyOut > 0n;
      const bestBuyOut = buyOnAero ? aeroBuyOut : bestCexBuy;
      const bestBuyDex = buyOnAero ? 'aerodrome' : bestCexBuyDex;

      if (bestBuyOut === 0n) return null;

      // ── Sell leg: tokenOut → tokenIn (Aerodrome + Uni V3 + PancakeSwap V3) ─
      const [aeroSellOut, uniSellRaw, cakeSellRaw] = await Promise.all([
        this.getAeroQuote(pair.tokenOut, pair.tokenIn, pair.stable, bestBuyOut),
        Promise.all(UNI_FEES.map(fee =>
          this.uniQuoter.quoteExactInputSingle.staticCall({
            tokenIn: pair.tokenOut, tokenOut: pair.tokenIn,
            amountIn: bestBuyOut, fee, sqrtPriceLimitX96: 0,
          }).then((r: any) => r[0] as bigint).catch(() => 0n)
        )),
        Promise.all(CAKE_FEES.map(fee =>
          this.cakeQuoter.quoteExactInputSingle.staticCall({
            tokenIn: pair.tokenOut, tokenOut: pair.tokenIn,
            amountIn: bestBuyOut, fee, sqrtPriceLimitX96: 0,
          }).then((r: any) => r[0] as bigint).catch(() => 0n)
        )),
      ]);

      const bestUniSell     = uniSellRaw.reduce((a, b) => b > a ? b : a, 0n);
      const bestUniSellFee  = UNI_FEES[uniSellRaw.indexOf(bestUniSell)] ?? 3000;
      const bestCakeSell    = cakeSellRaw.reduce((a, b) => b > a ? b : a, 0n);
      const bestCakeSellFee = CAKE_FEES[cakeSellRaw.indexOf(bestCakeSell)] ?? 2500;

      const bestCexSell    = bestUniSell > bestCakeSell ? bestUniSell : bestCakeSell;
      const bestCexSellDex = bestUniSell > bestCakeSell ? `uni-v3@${bestUniSellFee}` : `cake-v3@${bestCakeSellFee}`;

      const sellOnAero  = aeroSellOut > bestCexSell && aeroSellOut > 0n;
      const bestSellOut = sellOnAero ? aeroSellOut : bestCexSell;
      const bestSellDex = sellOnAero ? 'aerodrome' : bestCexSellDex;

      if (bestSellOut === 0n) return null;

      // Reject same-DEX round-trips — no edge if both legs use the same protocol
      const buyProto  = bestBuyDex.split('@')[0];
      const sellProto = bestSellDex.split('@')[0];
      if (buyProto === sellProto) return null;

      const spreadBps = loanAmount > 0n
        ? Number(((bestSellOut - loanAmount) * 10_000n) / loanAmount)
        : 0;

      // ── Anomaly gate ─────────────────────────────────────────────────────────
      if (Math.abs(spreadBps) > ANOMALY_THRESHOLD_BPS) {
        logger.debug('AERO', `${pair.name} anomaly spread=${spreadBps}bps (gate: ±${ANOMALY_THRESHOLD_BPS}bps)`);
        return {
          pair: pair.name, tokenIn: pair.tokenIn, tokenOut: pair.tokenOut,
          buyDex: bestBuyDex, sellDex: bestSellDex,
          spreadBps, loanAmount, grossProfit: 0n, opportunity: null,
          filterResult: 'anomaly',
        };
      }

      const isOpportunity = spreadBps >= CONFIG.MIN_PROFIT_BPS;

      const hash = opportunityHash({
        chainId:      CONFIG.CHAIN_ID,
        strategyId:   'apex.aerodrome_spread',
        feeTier:      0,
        tokenIn:      pair.tokenIn,
        tokenOut:     pair.tokenOut,
        quotedInput:  loanAmount.toString(),
        quotedOutput: bestSellOut.toString(),
      });

      logger.debug('AERO', `${pair.name} spread=${spreadBps}bps buy=${bestBuyDex} sell=${bestSellDex}`);

      const grossProfitRaw = bestSellOut > loanAmount ? bestSellOut - loanAmount : 0n;
      const isWethIn = pair.tokenIn.toLowerCase() === CONFIG.TOKENS.WETH.toLowerCase();
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
        netProfitUsd:     parseFloat(Math.max(0, grossUsd - gasUsd - grossUsd * (CONFIG.FLASH_LOAN_FEE_BPS / 10_000)).toFixed(4)),
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
        grossProfit: grossProfitRaw,
        opportunity: isOpportunity ? opp : null,
        filterResult: isOpportunity ? 'pass' : 'skip',
      };
    } catch (err: any) {
      logger.debug('AERO', `${pair.name} scan error: ${err.message}`);
      return null;
    }
  }
}
