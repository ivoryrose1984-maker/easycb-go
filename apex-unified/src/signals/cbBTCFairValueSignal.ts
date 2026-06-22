import { ethers }    from 'ethers';
import CONFIG         from '../core/config';
import { getCexFeed, getCoinGeckoPrice } from './cexContextSignal';
import { getCompetitionWindow, adjustedThreshold } from '../core/clock';
import { Opportunity } from '../types/Opportunity';
import { opportunityHash } from '../core/dedup';
import { logger } from '../core/logger';

// ── cbBTC fair-value oracle ────────────────────────────────────────────────────
//
// cbBTC is Coinbase Wrapped Bitcoin on Base — 1:1 redeemable for BTC.
// There is no on-chain exchangeRate() function; fair value is always exactly
// 1 BTC.  We derive the cbBTC/ETH fair rate from Chainlink:
//
//   fairWethPerCbBtc = BTC/USD ÷ ETH/USD
//
// Source priority:
//   1. Chainlink BTC/USD ÷ ETH/USD (both 8-dec, 3600s heartbeat)
//   2. CoinGecko BTC/USD ÷ ETH/USD (30s REST cache, no geo-block)
//   3. In-memory cache from last successful call
//   4. No hardcoded fallback — if all fail, return null (no fake opps)
//
// Base mainnet Chainlink feeds (8 decimals):
//   BTC/USD: 0xCCADC697c55bbB68dc5bCdf8d3CBe83CdD4E071E  (3600s heartbeat)
//   ETH/USD: 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70  (shared with cbETH)
//
// cbBTC uses 8 decimals (satoshi scale), not 18 like cbETH.

const CHAINLINK_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
];
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160,uint32,uint256)',
];

// 25 hours — Chainlink BTC/USD heartbeat is 3600s; allow generous grace
const STALE_RATE_SECS = 90_000;

// Probe: 0.05 cbBTC (8 dec).  At $90k BTC / $3k ETH that's ~1.5 ETH equivalent.
// gasAsBps = (0.00005 / 1.5) × 10000 ≈ 0.33 bps — negligible.
// The ±200 bps anomaly gate catches thin-pool price impact if the pool
// cannot fill 0.05 cbBTC cleanly.
const PROBE_CBBTC = ethers.parseUnits('0.05', 8); // 5_000_000 satoshis

// Fee tiers to try. cbBTC/WETH tends to use 0.3% on Base.
const UNI_FEE_TIERS  = [3000, 500, 10000] as const;
const CAKE_FEE_TIERS = [3000, 500, 10000] as const;

// Cost model (same philosophy as cbETH signal)
const GAS_ETH          = 0.00005;   // ceiling Base L2 tx cost in ETH
const BUY_SIDE_FEE_BPS = 5;         // 0.05% buy-leg buffer
const LATENCY_BPS      = 3;
const FAILURE_BPS      = 3;

export interface CbBtcSignalResult {
  opportunity:  Opportunity | null;
  grossEdgeBps: number;
  netEdgeBps:   number;
  cexEthMid:    number | null;
  window:       ReturnType<typeof getCompetitionWindow>;
  threshold:    number;
  totalCostBps: number;
}

class CbBtcRateOracle {
  private clBtc: ethers.Contract;
  private clEth: ethers.Contract;
  private cachedRate: number | null = null;  // btcUsd / ethUsd = ETH per BTC
  private cachedAt    = 0;
  private _lastErrLog = 0;

  constructor(provider: ethers.Provider) {
    this.clBtc = new ethers.Contract(CONFIG.CONTRACTS.CHAINLINK_BTC_USD, CHAINLINK_ABI, provider);
    this.clEth = new ethers.Contract(CONFIG.CONTRACTS.CHAINLINK_ETH_USD, CHAINLINK_ABI, provider);
  }

  async getRate(): Promise<{ rate: number; source: string } | null> {
    // 1. Chainlink BTC/USD ÷ ETH/USD
    try {
      const [[, btcUsd, , btcUpdated], [, ethUsd, , ethUpdated]] = await Promise.all([
        this.clBtc.latestRoundData() as Promise<[bigint, bigint, bigint, bigint, bigint]>,
        this.clEth.latestRoundData() as Promise<[bigint, bigint, bigint, bigint, bigint]>,
      ]);

      const oldestUpdate = Math.min(Number(btcUpdated), Number(ethUpdated));
      const staleSecs    = Math.floor(Date.now() / 1000) - oldestUpdate;

      if (btcUsd > 0n && ethUsd > 0n && staleSecs < STALE_RATE_SECS) {
        const rate = Number(btcUsd) / Number(ethUsd);  // BTC/ETH ratio (e.g., 30.0)
        this.cachedRate = rate;
        this.cachedAt   = Date.now();
        return { rate, source: `chainlink (age=${Math.round(staleSecs / 3600)}h)` };
      }
    } catch (err: any) {
      const now = Date.now();
      if (now - this._lastErrLog > 300_000) {
        logger.warn('cbBTC', `Chainlink feed error (throttled): ${err.message.slice(0, 100)}`);
        this._lastErrLog = now;
      }
    }

    // 2. CoinGecko BTC/USD ÷ ETH/USD
    try {
      const cg = await getCoinGeckoPrice();
      if (cg && cg.btcUsd > 0 && cg.ethUsd > 0) {
        const rate = cg.btcUsd / cg.ethUsd;
        this.cachedRate = rate;
        this.cachedAt   = Date.now();
        logger.info('cbBTC', `Exchange rate from CoinGecko: BTC/ETH=${rate.toFixed(4)} (BTC=$${cg.btcUsd.toFixed(0)}, ETH=$${cg.ethUsd.toFixed(0)})`);
        return { rate, source: 'coingecko' };
      }
    } catch (err: any) {
      logger.warn('cbBTC', `CoinGecko rate error: ${err.message}`);
    }

    // 3. In-memory cache
    if (this.cachedRate !== null) {
      const ageMin = Math.round((Date.now() - this.cachedAt) / 60_000);
      logger.warn('cbBTC', `Using cached BTC/ETH rate (age=${ageMin}m)`);
      return { rate: this.cachedRate, source: `cache (age=${ageMin}m)` };
    }

    // No fallback constant — unlike cbETH, a hardcoded BTC/ETH ratio would be
    // too volatile to be useful and could generate false positives.
    logger.error('cbBTC', 'All rate sources failed — skipping block');
    return null;
  }
}

export class CbBtcFairValueSignal {
  private oracle:           CbBtcRateOracle;
  private uniQuoter:       ethers.Contract;
  private cakeQuoter:      ethers.Contract;
  private _lastQuoterErrLog = 0;

  constructor(provider: ethers.Provider) {
    this.oracle     = new CbBtcRateOracle(provider);
    this.uniQuoter  = new ethers.Contract(CONFIG.CONTRACTS.UNI_QUOTER,  QUOTER_ABI, provider);
    this.cakeQuoter = new ethers.Contract(CONFIG.CONTRACTS.CAKE_QUOTER, QUOTER_ABI, provider);
  }

  async scan(blockNumber: number): Promise<CbBtcSignalResult | null> {
    const t0 = Date.now();

    const rateResult = await this.oracle.getRate();
    if (!rateResult) return null;

    const { rate: fairWethPerCbBtc, source: rateSource } = rateResult;

    let dexWethOut: bigint | null = null;
    let feeTierUsed = 0;
    let dexSource   = 'uni-v3';

    const tryQuoter = async (
      quoter: ethers.Contract,
      dex: string,
      feeTiers: readonly number[],
    ): Promise<void> => {
      for (const fee of feeTiers) {
        try {
          const [amountOut] = await quoter.quoteExactInputSingle.staticCall({
            tokenIn:           CONFIG.TOKENS.cbBTC,
            tokenOut:          CONFIG.TOKENS.WETH,
            amountIn:          PROBE_CBBTC,
            fee,
            sqrtPriceLimitX96: 0n,
          });
          dexWethOut  = amountOut as bigint;
          feeTierUsed = fee;
          dexSource   = dex;
          return;
        } catch { /* fee tier has no pool — try next */ }
      }
    };

    await tryQuoter(this.uniQuoter, 'uni-v3', UNI_FEE_TIERS);
    if (dexWethOut === null) {
      await tryQuoter(this.cakeQuoter, 'cake-v3', CAKE_FEE_TIERS);
    }

    if (dexWethOut === null) {
      const now = Date.now();
      if (now - this._lastQuoterErrLog > 300_000) {
        logger.warn('cbBTC', 'Quoter failed all fee tiers for cbBTC/WETH (throttled)');
        this._lastQuoterErrLog = now;
      }
      return null;
    }
    const resolvedOut = dexWethOut as bigint; // async closure mutation — TypeScript can't narrow, cast required

    // cbBTC is 8 dec, WETH is 18 dec — scale to get ETH-per-BTC DEX ratio
    const dexWethPerCbBtc = (Number(resolvedOut) / 1e18) / (Number(PROBE_CBBTC) / 1e8);
    const grossEdgeBps    = ((dexWethPerCbBtc - fairWethPerCbBtc) / fairWethPerCbBtc) * 10_000;

    // Anomaly gate: cbBTC/WETH should not deviate >200 bps from fair value
    if (Math.abs(grossEdgeBps) > 200) {
      logger.debug('cbBTC', `block=${blockNumber} anomaly gross=${grossEdgeBps.toFixed(2)}bps (${dexSource}@${feeTierUsed}) — thin pool, skipping`);
      return null;
    }

    const cex         = getCexFeed();
    const cexEthMid   = cex.getMid('ethusdc') ?? (await getCoinGeckoPrice())?.ethUsd ?? null;
    const window      = getCompetitionWindow();
    const threshold   = adjustedThreshold(CONFIG.MIN_NET_EDGE_BPS);

    // Probe size in ETH-equivalent (for gas cost calculation)
    const probeSizeEth  = (Number(PROBE_CBBTC) / 1e8) * fairWethPerCbBtc;
    const gasAsBps      = (GAS_ETH / probeSizeEth) * 10_000;
    const totalCostBps  = gasAsBps + BUY_SIDE_FEE_BPS + LATENCY_BPS + FAILURE_BPS;
    const netEdgeBps    = grossEdgeBps - totalCostBps;

    const rpcLatencyMs   = Date.now() - t0;
    const ethPriceUsd    = cexEthMid ?? 3_000;
    const grossProfitEth = (grossEdgeBps / 10_000) * probeSizeEth;
    const grossProfitUsd = parseFloat((grossProfitEth * ethPriceUsd).toFixed(4));
    const gasUsd         = GAS_ETH * ethPriceUsd;
    const netProfitUsd   = parseFloat(Math.max(0, grossProfitUsd - gasUsd - grossProfitUsd * (CONFIG.FLASH_LOAN_FEE_BPS / 10_000)).toFixed(4));

    logger.debug('cbBTC',
      `block=${blockNumber} rate=${fairWethPerCbBtc.toFixed(4)} source=${rateSource} dex=${dexSource}@${feeTierUsed} ` +
      `gross=${grossEdgeBps.toFixed(2)}bps net=${netEdgeBps.toFixed(2)}bps ` +
      `costs=${totalCostBps.toFixed(1)}bps thresh=${threshold.toFixed(2)}bps[${window.label}] ` +
      `grossUsd=$${grossProfitUsd.toFixed(2)} latency=${rpcLatencyMs}ms`
    );

    const hash = opportunityHash({
      chainId:      CONFIG.CHAIN_ID,
      strategyId:   'grok.cbbtc_fair_value',
      feeTier:      feeTierUsed,
      tokenIn:      CONFIG.TOKENS.cbBTC,
      tokenOut:     CONFIG.TOKENS.WETH,
      quotedInput:  PROBE_CBBTC.toString(),
      quotedOutput: resolvedOut.toString(),
    });

    const isOpportunity = netEdgeBps >= threshold;

    const opp: Opportunity = {
      timestamp:        new Date().toISOString(),
      blockNumber,
      chainId:          CONFIG.CHAIN_ID,
      botId:            CONFIG.BOT_ID,
      runId:            CONFIG.RUN_ID,
      strategyId:       'grok.cbbtc_fair_value',
      opportunityHash:  hash,
      tokenIn:          CONFIG.TOKENS.cbBTC,
      tokenOut:         CONFIG.TOKENS.WETH,
      route:            `cbBTC→WETH (${dexSource}@${feeTierUsed})`,
      dex:              dexSource,
      feeTier:          feeTierUsed,
      quotedInput:      PROBE_CBBTC.toString(),
      quotedOutput:     resolvedOut.toString(),
      fairValuePrice:   fairWethPerCbBtc,
      dexPrice:         dexWethPerCbBtc,
      cexPrice:         cexEthMid,
      spreadBps:        parseFloat(grossEdgeBps.toFixed(4)),
      grossProfitUsd,
      netProfitUsd,
      gasEstimate:      GAS_ETH.toFixed(6),
      slippageEstimate: 5,
      flashLoanFeeEst:  0,
      builderFeeEst:    0,
      confidenceScore:  Math.min(100, Math.max(0, Math.round(netEdgeBps * 5))),
      rejectionReason:  isOpportunity ? null : `Net ${netEdgeBps.toFixed(2)}bps below ${threshold.toFixed(2)}bps threshold [${window.label}]`,
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
      threshold,
      totalCostBps,
    };
  }
}
