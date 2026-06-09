import { ethers }    from 'ethers';
import CONFIG         from '../core/config';
import { getCexFeed } from './cexContextSignal';
import { getCompetitionWindow, adjustedThreshold } from '../core/clock';
import { Opportunity } from '../types/Opportunity';
import { opportunityHash } from '../core/dedup';
import { logger } from '../core/logger';

// ── cbETH exchange-rate oracle ────────────────────────────────────────────────
//
// Source priority:
//   1. cbETH contract exchangeRate() — only works on Ethereum L1; always fails on Base
//   2. Chainlink cbETH/ETH Exchange Rate feed on Base (live, 24h heartbeat)
//   3. In-memory cache from last successful call (survives short Chainlink outages)
//   4. Hardcoded constant — absolute last resort, logs ERROR, signal unreliable
//
// Chainlink address: https://docs.chain.link/data-feeds/price-feeds/addresses?network=base
// cbETH/ETH Exchange Rate — Base mainnet: 0x806b4Ac04501c29769051e42783cF04dCE41440b
const CHAINLINK_CBETH_ETH = '0x806b4Ac04501c29769051e42783cF04dCE41440b';

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

const PROBE_WETH = ethers.parseEther('3.33');
const FEE_TIERS  = [500, 100, 3000] as const;

export interface CbEthSignalResult {
  opportunity:  Opportunity | null;
  grossEdgeBps: number;
  netEdgeBps:   number;
  cexEthMid:    number | null;
  window:       ReturnType<typeof getCompetitionWindow>;
}

class CbEthRateOracle {
  private chainlink:  ethers.Contract;
  private cbethL1:    ethers.Contract;
  private cachedRate: bigint | null = null;
  private cachedAt    = 0;

  constructor(provider: ethers.Provider) {
    this.chainlink = new ethers.Contract(CHAINLINK_CBETH_ETH, CHAINLINK_ABI, provider);
    this.cbethL1   = new ethers.Contract(CONFIG.TOKENS.cbETH, CBETH_ABI, provider);
  }

  async getRate(): Promise<{ rate: bigint; source: string }> {
    // 1. L1 staking contract (always fails on Base, kept for future compat)
    try {
      const rate = await this.cbethL1.exchangeRate() as bigint;
      if (rate > 1_000_000_000_000_000_000n) { // sanity: must be > 1.0e18
        this.cachedRate = rate;
        this.cachedAt   = Date.now();
        return { rate, source: 'cbeth.exchangeRate()' };
      }
    } catch { /* expected on Base */ }

    // 2. Chainlink cbETH/ETH Exchange Rate feed
    try {
      const [, answer, , updatedAt] = await this.chainlink.latestRoundData() as
        [bigint, bigint, bigint, bigint, bigint];
      const staleSecs = Math.floor(Date.now() / 1000) - Number(updatedAt);
      const rate      = BigInt(answer);

      if (rate > 1_000_000_000_000_000_000n && staleSecs < STALE_RATE_SECS) {
        this.cachedRate = rate;
        this.cachedAt   = Date.now();
        return { rate, source: `chainlink (age=${Math.round(staleSecs / 3600)}h)` };
      }

      if (rate > 0n) {
        logger.warn('cbETH', `Chainlink rate stale (${Math.round(staleSecs / 3600)}h old) — falling back to cache`);
        // Still update cache if stale but plausible — better than nothing
        if (this.cachedRate === null) {
          this.cachedRate = rate;
          this.cachedAt   = Date.now();
        }
      }
    } catch (err: any) {
      logger.warn('cbETH', `Chainlink feed error: ${err.message}`);
    }

    // 3. In-memory cache from last successful call
    if (this.cachedRate !== null) {
      const ageMin = Math.round((Date.now() - this.cachedAt) / 60_000);
      logger.warn('cbETH', `Using cached exchange rate (age=${ageMin}m)`);
      return { rate: this.cachedRate, source: `cache (age=${ageMin}m)` };
    }

    // 4. Hardcoded constant — loud error, signal data is unreliable
    logger.error('cbETH', 'All rate sources failed — using hardcoded fallback. cbETH signal is UNRELIABLE. Check Chainlink feed.');
    return { rate: CBETH_FALLBACK_RATE, source: 'HARDCODED_FALLBACK' };
  }
}

export class CbEthFairValueSignal {
  private oracle: CbEthRateOracle;
  private quoter: ethers.Contract;

  constructor(provider: ethers.Provider) {
    this.oracle = new CbEthRateOracle(provider);
    this.quoter = new ethers.Contract(CONFIG.CONTRACTS.UNI_QUOTER, QUOTER_ABI, provider);
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

    for (const fee of FEE_TIERS) {
      try {
        const [amountOut] = await this.quoter.quoteExactInputSingle.staticCall({
          tokenIn:           CONFIG.TOKENS.cbETH,
          tokenOut:          CONFIG.TOKENS.WETH,
          amountIn:          PROBE_WETH,
          fee,
          sqrtPriceLimitX96: 0n,
        });
        dexWethOut  = amountOut as bigint;
        feeTierUsed = fee;
        break;
      } catch { continue; }
    }

    if (dexWethOut === null) {
      logger.warn('cbETH', 'No DEX quote available — skipping block');
      return null;
    }

    const dexWethPerCbEth = Number(dexWethOut) / Number(PROBE_WETH);
    const grossEdgeBps    = ((dexWethPerCbEth - fairWethPerCbEth) / fairWethPerCbEth) * 10_000;

    const cex        = getCexFeed();
    const cexEthMid  = cex.getMid('ethusdc');
    const window     = getCompetitionWindow();
    const threshold  = adjustedThreshold(CONFIG.MIN_NET_EDGE_BPS);

    const gasEth       = 0.0003;
    const probeSizeEth = Number(ethers.formatEther(PROBE_WETH));
    const gasAsBps     = (gasEth / probeSizeEth) * 10_000;
    const totalCosts   = gasAsBps + 5 + (feeTierUsed / 100) + 10 + 5;
    const netEdgeBps   = grossEdgeBps - totalCosts;

    const hash = opportunityHash({
      chainId:      CONFIG.CHAIN_ID,
      blockNumber,
      strategyId:   'grok.cbeth_fair_value',
      feeTier:      feeTierUsed,
      tokenIn:      CONFIG.TOKENS.cbETH,
      tokenOut:     CONFIG.TOKENS.WETH,
      quotedInput:  PROBE_WETH.toString(),
      quotedOutput: dexWethOut.toString(),
    });

    const isOpportunity = netEdgeBps >= threshold;
    const rpcLatencyMs  = Date.now() - t0;

    const ethPriceUsd    = cexEthMid ?? 3_000;
    const grossProfitEth = (grossEdgeBps / 10_000) * probeSizeEth;
    const grossProfitUsd = parseFloat((grossProfitEth * ethPriceUsd).toFixed(4));
    const gasUsd         = 0.0003 * ethPriceUsd;
    const netProfitUsd   = parseFloat(Math.max(0, grossProfitUsd - gasUsd - grossProfitUsd * 0.0005).toFixed(4));

    logger.debug('cbETH',
      `block=${blockNumber} rate=${fairWethPerCbEth.toFixed(6)} source=${rateSource} ` +
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
      route:            `cbETH→WETH (fee=${feeTierUsed})`,
      dex:              'uniswap-v3',
      feeTier:          feeTierUsed,
      quotedInput:      PROBE_WETH.toString(),
      quotedOutput:     dexWethOut.toString(),
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
