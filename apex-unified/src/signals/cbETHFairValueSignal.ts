import { ethers }    from 'ethers';
import { createHash } from 'crypto';
import CONFIG         from '../core/config';
import { getCexFeed } from './cexContextSignal';
import { getCompetitionWindow, adjustedThreshold } from '../core/clock';
import { Opportunity } from '../types/Opportunity';
import { opportunityHash } from '../core/dedup';
import { logger } from '../core/logger';

const CBETH_ABI  = ['function exchangeRate() view returns (uint256)'];
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160,uint32,uint256)',
];

const PROBE_WETH = ethers.parseEther('3.33');
const FEE_TIERS  = [500, 100, 3000] as const;

export interface CbEthSignalResult {
  opportunity:  Opportunity | null;
  grossEdgeBps: number;
  netEdgeBps:   number;
  cexEthMid:    number | null;
  window:       ReturnType<typeof getCompetitionWindow>;
}

export class CbEthFairValueSignal {
  private cbeth:  ethers.Contract;
  private quoter: ethers.Contract;

  constructor(provider: ethers.Provider) {
    this.cbeth  = new ethers.Contract(CONFIG.TOKENS.cbETH, CBETH_ABI,  provider);
    this.quoter = new ethers.Contract(CONFIG.CONTRACTS.UNI_QUOTER, QUOTER_ABI, provider);
  }

  async scan(provider: ethers.Provider, blockNumber: number): Promise<CbEthSignalResult | null> {
    const t0 = Date.now();

    let exchangeRateRaw: bigint;
    try {
      exchangeRateRaw = await this.cbeth.exchangeRate() as bigint;
    } catch (err: any) {
      logger.error('cbETH', `exchangeRate() failed: ${err.message}`);
      return null;
    }

    const fairWethPerCbEth = Number(exchangeRateRaw) / 1e18;

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

    // Gas cost in ETH (conservative Base L2 estimate)
    const gasEth       = 0.0003;
    const probeSizeEth = Number(ethers.formatEther(PROBE_WETH));
    const gasAsBps     = (gasEth / probeSizeEth) * 10_000;
    const totalCosts   = gasAsBps + 5 + (feeTierUsed / 100) + 10 + 5; // slippage+dexFee+safety+revert
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

    logger.debug('cbETH', `block=${blockNumber} gross=${grossEdgeBps.toFixed(2)}bps net=${netEdgeBps.toFixed(2)}bps thresh=${threshold.toFixed(2)}bps latency=${rpcLatencyMs}ms`);

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
      grossProfitUsd:   0,
      netProfitUsd:     0,
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
