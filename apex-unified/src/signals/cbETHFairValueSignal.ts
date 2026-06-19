import { ethers }    from 'ethers';
import CONFIG         from '../core/config';
import { getCexFeed, getCoinGeckoPrice } from './cexContextSignal';
import { getCompetitionWindow, adjustedThreshold } from '../core/clock';
import { Opportunity } from '../types/Opportunity';
import { opportunityHash } from '../core/dedup';
import { logger } from '../core/logger';

// ── cbETH exchange-rate oracle ────────────────────────────────────────────────
//
// Source priority:
//   1. cbETH contract exchangeRate() — only works on Ethereum L1; always fails on Base
//   2. Chainlink cbETH/USD ÷ ETH/USD → cbETH/ETH ratio (both 8-dec, 24h heartbeat)
//   3. CoinGecko cbETH/USD ÷ ETH/USD (30s REST cache, no geo-block, no auth)
//   4. In-memory cache from last successful call (survives outages)
//   5. Hardcoded constant — absolute last resort, logs ERROR, signal unreliable
//
// Base mainnet Chainlink feeds:
//   cbETH/USD: 0xd7818272B9e248357d13057AAb0B417aF31E817d  (may be deprecated)
//   ETH/USD:   0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70
const CHAINLINK_CBETH_USD = '0xd7818272B9e248357d13057AAb0B417aF31E817d';
const CHAINLINK_ETH_USD   = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';

const CHAINLINK_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
];
const CBETH_ABI  = ['function exchangeRate() view returns (uint256)'];
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160,uint32,uint256)',
];

// 25 hours — Chainlink cbETH/ETH heartbeat is 24h; we allow +1h grace
const STALE_RATE_SECS  = 90_000;
// Only used if Chainlink + cache both fail — logs ERROR every block it's used
const CBETH_FALLBACK_RATE = 1_065_000_000_000_000_000n; // 1.065e18

const PROBE_WETH = ethers.parseEther('0.5');   // reduced from 3.33 — avoids thin-pool revert
const FEE_TIERS  = [500, 100, 3000, 10000] as const;

export interface CbEthSignalResult {
  opportunity:  Opportunity | null;
  grossEdgeBps: number;
  netEdgeBps:   number;
  cexEthMid:    number | null;
  window:       ReturnType<typeof getCompetitionWindow>;
}

class CbEthRateOracle {
  private clCbEth:    ethers.Contract;
  private clEth:      ethers.Contract;
  private cbethL1:    ethers.Contract;
  private cachedRate: bigint | null = null;
  private cachedAt    = 0;

  constructor(provider: ethers.Provider) {
    this.clCbEth = new ethers.Contract(CHAINLINK_CBETH_USD, CHAINLINK_ABI, provider);
    this.clEth   = new ethers.Contract(CHAINLINK_ETH_USD,   CHAINLINK_ABI, provider);
    this.cbethL1 = new ethers.Contract(CONFIG.TOKENS.cbETH, CBETH_ABI,     provider);
  }

  async getRate(): Promise<{ rate: bigint; source: string }> {
    // 1. L1 staking contract (always fails on Base, kept for future compat)
    try {
      const rate = await this.cbethL1.exchangeRate() as bigint;
      if (rate > 1_000_000_000_000_000_000n) {
        this.cachedRate = rate;
        this.cachedAt   = Date.now();
        return { rate, source: 'cbeth.exchangeRate()' };
      }
    } catch { /* expected on Base */ }

    // 2. Chainlink cbETH/USD ÷ ETH/USD → cbETH/ETH (both feeds are 8-dec)
    //    cbETH/ETH (18-dec) = cbEthUsd * 1e18 / ethUsd
    try {
      const [[, cbEthUsd, , cbEthUpdated], [, ethUsd, , ethUpdated]] = await Promise.all([
        this.clCbEth.latestRoundData() as Promise<[bigint, bigint, bigint, bigint, bigint]>,
        this.clEth.latestRoundData()   as Promise<[bigint, bigint, bigint, bigint, bigint]>,
      ]);

      const oldestUpdate = Math.min(Number(cbEthUpdated), Number(ethUpdated));
      const staleSecs    = Math.floor(Date.now() / 1000) - oldestUpdate;

      if (cbEthUsd > 0n && ethUsd > 0n && staleSecs < STALE_RATE_SECS) {
        const rate = (BigInt(cbEthUsd) * 10n ** 18n) / BigInt(ethUsd);
        this.cachedRate = rate;
        this.cachedAt   = Date.now();
        return { rate, source: `chainlink (age=${Math.round(staleSecs / 3600)}h)` };
      }

      if (cbEthUsd > 0n && ethUsd > 0n) {
        logger.warn('cbETH', `Chainlink rate stale (${Math.round(staleSecs / 3600)}h old) — using cache`);
        if (this.cachedRate === null) {
          this.cachedRate = (BigInt(cbEthUsd) * 10n ** 18n) / BigInt(ethUsd);
          this.cachedAt   = Date.now();
        }
      }
    } catch (err: any) {
      logger.warn('cbETH', `Chainlink feed error: ${err.message}`);
    }

    // 3. CoinGecko cbETH/USD ÷ ETH/USD (30s REST cache, no geo-block)
    try {
      const cg = await getCoinGeckoPrice();
      if (cg && cg.cbethRatio > 0) {
        const rate = BigInt(Math.round(cg.cbethRatio * 1e18));
        this.cachedRate = rate;
        this.cachedAt   = Date.now();
        logger.info('cbETH', `Exchange rate from CoinGecko: ${cg.cbethRatio.toFixed(6)} (cbETH=$${cg.cbethUsd.toFixed(2)}, ETH=$${cg.ethUsd.toFixed(2)})`);
        return { rate, source: 'coingecko' };
      }
    } catch (err: any) {
      logger.warn('cbETH', `CoinGecko rate error: ${err.message}`);
    }

    // 4. In-memory cache from last successful call
    if (this.cachedRate !== null) {
      const ageMin = Math.round((Date.now() - this.cachedAt) / 60_000);
      logger.warn('cbETH', `Using cached exchange rate (age=${ageMin}m)`);
      return { rate: this.cachedRate, source: `cache (age=${ageMin}m)` };
    }

    // 5. Hardcoded constant — loud error, signal data is unreliable
    logger.error('cbETH', 'All rate sources failed — using hardcoded fallback. cbETH signal is UNRELIABLE.');
    return { rate: CBETH_FALLBACK_RATE, source: 'HARDCODED_FALLBACK' };
  }
}

export class CbEthFairValueSignal {
  private oracle:      CbEthRateOracle;
  private uniQuoter:  ethers.Contract;
  private cakeQuoter: ethers.Contract;

  constructor(provider: ethers.Provider) {
    this.oracle      = new CbEthRateOracle(provider);
    this.uniQuoter  = new ethers.Contract(CONFIG.CONTRACTS.UNI_QUOTER,  QUOTER_ABI, provider);
    this.cakeQuoter = new ethers.Contract(CONFIG.CONTRACTS.CAKE_QUOTER, QUOTER_ABI, provider);
  }

  async scan(provider: ethers.Provider, blockNumber: number): Promise<CbEthSignalResult | null> {
    const t0 = Date.now();

    const { rate: exchangeRateRaw, source: rateSource } = await this.oracle.getRate();
    const fairWethPerCbEth = Number(exchangeRateRaw) / 1e18;

    // Abort if using hardcoded fallback — don't log fake opportunities
    if (rateSource === 'HARDCODED_FALLBACK') {
      return null;
    }

    let dexWethOut: bigint | null = null;
    let feeTierUsed = 0;
    let dexSource = 'uni-v3';

    const tryQuoter = async (quoter: ethers.Contract, label: string): Promise<string[]> => {
      const errs: string[] = [];
      for (const fee of FEE_TIERS) {
        try {
          const [amountOut] = await quoter.quoteExactInputSingle.staticCall({
            tokenIn:           CONFIG.TOKENS.cbETH,
            tokenOut:          CONFIG.TOKENS.WETH,
            amountIn:          PROBE_WETH,
            fee,
            sqrtPriceLimitX96: 0n,
          });
          dexWethOut  = amountOut as bigint;
          feeTierUsed = fee;
          dexSource   = label;
          return [];
        } catch (e: any) {
          errs.push(`${label}@${fee}:${e?.code ?? e?.message?.slice(0, 40) ?? 'unknown'}`);
        }
      }
      return errs;
    };

    const uniErrs  = await tryQuoter(this.uniQuoter,  'uni-v3');
    const cakeErrs = dexWethOut === null ? await tryQuoter(this.cakeQuoter, 'cake-v3') : [];
    const allErrors = [...uniErrs, ...cakeErrs];

    if (dexWethOut === null && allErrors.length > 0) {
      logger.warn('cbETH', `Quoter failed all fee tiers: ${allErrors.join(' | ')}`);
    }

    if (dexWethOut === null) {
      logger.warn('cbETH', 'No DEX quote available — skipping block');
      return null;
    }
    const resolvedOut = dexWethOut as bigint; // async closure mutation — TypeScript can't narrow, cast required

    const dexWethPerCbEth = Number(resolvedOut) / Number(PROBE_WETH);
    const grossEdgeBps    = ((dexWethPerCbEth - fairWethPerCbEth) / fairWethPerCbEth) * 10_000;

    const cex           = getCexFeed();
    const binanceEthMid = cex.getMid('ethusdc');
    // CoinGecko fallback when Binance is geo-blocked or disabled (30s cache, no auth)
    const cexEthMid = binanceEthMid ?? (await getCoinGeckoPrice())?.ethUsd ?? null;
    const window     = getCompetitionWindow();
    const threshold  = adjustedThreshold(CONFIG.MIN_NET_EDGE_BPS);

    const gasEth       = 0.0003;
    const probeSizeEth = Number(ethers.formatEther(PROBE_WETH));
    const gasAsBps     = (gasEth / probeSizeEth) * 10_000;
    const totalCosts   = gasAsBps + 5 + (feeTierUsed / 100) + CONFIG.LATENCY_BUFFER_BPS + CONFIG.FAILURE_BUFFER_BPS;
    const netEdgeBps   = grossEdgeBps - totalCosts;

    const hash = opportunityHash({
      chainId:      CONFIG.CHAIN_ID,
      strategyId:   'grok.cbeth_fair_value',
      feeTier:      feeTierUsed,
      tokenIn:      CONFIG.TOKENS.cbETH,
      tokenOut:     CONFIG.TOKENS.WETH,
      quotedInput:  PROBE_WETH.toString(),
      quotedOutput: resolvedOut.toString(),
    });

    const isOpportunity = netEdgeBps >= threshold;
    const rpcLatencyMs  = Date.now() - t0;

    const ethPriceUsd    = cexEthMid ?? 3_000;
    const grossProfitEth = (grossEdgeBps / 10_000) * probeSizeEth;
    const grossProfitUsd = parseFloat((grossProfitEth * ethPriceUsd).toFixed(4));
    const gasUsd         = 0.0003 * ethPriceUsd;
    const netProfitUsd   = parseFloat(Math.max(0, grossProfitUsd - gasUsd - grossProfitUsd * (CONFIG.FLASH_LOAN_FEE_BPS / 10_000)).toFixed(4));

    logger.debug('cbETH',
      `block=${blockNumber} rate=${fairWethPerCbEth.toFixed(6)} source=${rateSource} dex=${dexSource}@${feeTierUsed} ` +
      `gross=${grossEdgeBps.toFixed(2)}bps net=${netEdgeBps.toFixed(2)}bps ` +
      `grossUsd=$${grossProfitUsd.toFixed(2)} thresh=${threshold.toFixed(2)}bps latency=${rpcLatencyMs}ms`
    );

    const opp: Opportunity = {
      timestamp:        new Date().toISOString(),
      blockNumber,
      chainId:          CONFIG.CHAIN_ID,
      botId:            CONFIG.BOT_ID,
      runId:            CONFIG.RUN_ID,
      strategyId:       'grok.cbeth_fair_value',
      opportunityHash:  hash,
      tokenIn:          CONFIG.TOKENS.cbETH,
      tokenOut:         CONFIG.TOKENS.WETH,
      route:            `cbETH→WETH (${dexSource}@${feeTierUsed})`,
      dex:              dexSource,
      feeTier:          feeTierUsed,
      quotedInput:      PROBE_WETH.toString(),
      quotedOutput:     resolvedOut.toString(),
      fairValuePrice:   fairWethPerCbEth,
      dexPrice:         dexWethPerCbEth,
      cexPrice:         cexEthMid,
      spreadBps:        parseFloat(grossEdgeBps.toFixed(4)),
      grossProfitUsd,
      netProfitUsd,
      gasEstimate:      gasEth.toFixed(6),
      slippageEstimate: 5,
      flashLoanFeeEst:  0,
      builderFeeEst:    0,
      confidenceScore:  Math.min(100, Math.max(0, Math.round(netEdgeBps * 5))),
      rejectionReason:  isOpportunity ? null : `Net ${netEdgeBps.toFixed(2)}bps below ${threshold.toFixed(2)}bps threshold`,
      safetyDecision:   'dry_run_only',
      dryRunOnly:       true,
      liveEligible:     false,
    };

    return {
      opportunity:  isOpportunity ? opp : null,
      grossEdgeBps: parseFloat(grossEdgeBps.toFixed(4)),
      netEdgeBps:   parseFloat(netEdgeBps.toFixed(4)),
      cexEthMid,
      window,
    };
  }
}
