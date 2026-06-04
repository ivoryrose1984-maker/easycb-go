import { ethers }   from 'ethers';
import CONFIG, { usdcToUsd } from '../core/config';
import { Opportunity } from '../types/Opportunity';
import { opportunityHash } from '../core/dedup';
import { logger } from '../core/logger';

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160,uint32,uint256)',
];

interface PathCandidate {
  tokens: [string, string, string];
  fees:   [number, number, number];
}

// Static whitelist of known-liquid 3-hop paths on Base (USDC round-trip).
// Replaces dynamic cartesian product (~180 paths) to keep RPC load under control.
// Each entry makes at most 3 sequential staticCalls; total ≤ 57 calls/block.
function buildCandidates(): PathCandidate[] {
  const { USDC, WETH, USDT, DAI, cbETH, cbBTC, AERO } = CONFIG.TOKENS;
  return [
    // ── cbETH ↔ WETH ────────────────────────────────────────────────────────
    { tokens: [USDC, WETH, cbETH], fees: [ 500,  500, 3000] },
    { tokens: [USDC, WETH, cbETH], fees: [ 500,  500,  500] },
    { tokens: [USDC, WETH, cbETH], fees: [3000,  500, 3000] },
    { tokens: [USDC, cbETH, WETH], fees: [3000,  500,  500] },
    { tokens: [USDC, cbETH, WETH], fees: [3000,  500, 3000] },
    { tokens: [USDC, cbETH, WETH], fees: [ 500,  500,  500] },
    // ── cbBTC ↔ WETH ────────────────────────────────────────────────────────
    { tokens: [USDC, WETH, cbBTC], fees: [ 500, 3000, 3000] },
    { tokens: [USDC, WETH, cbBTC], fees: [3000, 3000, 3000] },
    { tokens: [USDC, cbBTC, WETH], fees: [3000, 3000,  500] },
    { tokens: [USDC, cbBTC, WETH], fees: [3000, 3000, 3000] },
    // ── USDT / DAI stablecoin legs ───────────────────────────────────────────
    { tokens: [USDC, USDT, WETH],  fees: [ 100,  500,  500] },
    { tokens: [USDC, USDT, WETH],  fees: [ 100,  500, 3000] },
    { tokens: [USDC, WETH, USDT],  fees: [ 500,  500,  100] },
    { tokens: [USDC, WETH, USDT],  fees: [3000,  500,  100] },
    { tokens: [USDC, DAI,  WETH],  fees: [ 100,  500,  500] },
    { tokens: [USDC, WETH, DAI],   fees: [ 500,  500,  100] },
    // ── AERO ────────────────────────────────────────────────────────────────
    { tokens: [USDC, WETH, AERO],  fees: [ 500, 3000, 3000] },
    { tokens: [USDC, AERO, WETH],  fees: [3000, 3000,  500] },
  ];
}

const CANDIDATES: PathCandidate[] = buildCandidates();

export interface TriangularResult {
  tokens:       [string, string, string];
  fees:         [number, number, number];
  amountIn:     bigint;
  amountOut:    bigint;
  grossProfit:  bigint;
  spreadBps:    number;
  opportunity:  Opportunity | null;
}

export class TriangularArbSignal {
  private quoter: ethers.Contract;

  constructor(provider: ethers.Provider) {
    this.quoter = new ethers.Contract(CONFIG.CONTRACTS.UNI_QUOTER, QUOTER_ABI, provider);
  }

  async scan(amountIn: bigint, blockNumber: number, ethPriceUsd: bigint = 3_000_000_000n): Promise<TriangularResult[]> {
    const results = await Promise.allSettled(
      CANDIDATES.map(c => this.simulate(c.tokens, c.fees, amountIn, blockNumber, ethPriceUsd))
    );

    const opportunities: TriangularResult[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        opportunities.push(r.value);
      }
    }

    opportunities.sort((a, b) => Number(b.grossProfit - a.grossProfit));
    return opportunities;
  }

  private async simulate(
    tokens:      [string, string, string],
    fees:        [number, number, number],
    amountIn:    bigint,
    blockNumber: number,
    ethPriceUsd: bigint,
  ): Promise<TriangularResult | null> {
    try {
      const q1 = await this.quoter.quoteExactInputSingle.staticCall({
        tokenIn: tokens[0], tokenOut: tokens[1], amountIn, fee: fees[0], sqrtPriceLimitX96: 0,
      });
      const out1: bigint = q1[0];
      if (out1 === 0n) return null;

      const q2 = await this.quoter.quoteExactInputSingle.staticCall({
        tokenIn: tokens[1], tokenOut: tokens[2], amountIn: out1, fee: fees[1], sqrtPriceLimitX96: 0,
      });
      const out2: bigint = q2[0];
      if (out2 === 0n) return null;

      const q3 = await this.quoter.quoteExactInputSingle.staticCall({
        tokenIn: tokens[2], tokenOut: tokens[0], amountIn: out2, fee: fees[2], sqrtPriceLimitX96: 0,
      });
      const finalOut: bigint = q3[0];
      if (finalOut === 0n || finalOut <= amountIn) return null;

      const grossProfit = finalOut - amountIn;
      const spreadBps   = Number((grossProfit * 10_000n) / amountIn);

      if (spreadBps < CONFIG.MIN_PROFIT_BPS) return null;

      const route = `USDC→${tokens[1].slice(0, 8)}…→${tokens[2].slice(0, 8)}…→USDC`;
      const hash  = opportunityHash({
        chainId:      CONFIG.CHAIN_ID,
        blockNumber,
        strategyId:   'apex.triangular',
        feeTier:      fees[0],
        tokenIn:      tokens[0],
        tokenOut:     tokens[0],
        quotedInput:  amountIn.toString(),
        quotedOutput: finalOut.toString(),
      });

      logger.debug('TRI', `${route} spread=${spreadBps}bps`);

      const opp: Opportunity = {
        timestamp:        new Date().toISOString(),
        blockNumber,
        chainId:          CONFIG.CHAIN_ID,
        botId:            CONFIG.BOT_ID,
        runId:            CONFIG.RUN_ID,
        strategyId:       'apex.triangular',
        opportunityHash:  hash,
        tokenIn:          tokens[0],
        tokenOut:         tokens[0],
        route,
        dex:              'uniswap-v3',
        feeTier:          fees[0],
        quotedInput:      amountIn.toString(),
        quotedOutput:     finalOut.toString(),
        fairValuePrice:   null,
        dexPrice:         Number(finalOut) / Number(amountIn),
        cexPrice:         null,
        spreadBps,
        grossProfitUsd:   usdcToUsd(grossProfit),
        netProfitUsd:     parseFloat(Math.max(0,
          usdcToUsd(grossProfit) - (0.0003 * (Number(ethPriceUsd) / 1e6)) - usdcToUsd(grossProfit) * 0.0015
        ).toFixed(4)),
        gasEstimate:      '0.0003',
        slippageEstimate: Math.min(250, Math.round(Math.sqrt(Number(amountIn) / 1e12) * 10)),
        flashLoanFeeEst:  0,
        builderFeeEst:    0,
        confidenceScore:  Math.min(100, Math.round(spreadBps)),
        rejectionReason:  null,
        safetyDecision:   'dry_run_only',
        dryRunOnly:       true,
        liveEligible:     false,
      };

      return { tokens, fees, amountIn, amountOut: finalOut, grossProfit, spreadBps, opportunity: opp };
    } catch { return null; }
  }
}

export function encodeTriangularPath(tokens: [string, string, string], fees: [number, number, number]): string {
  const [t0, t1, t2] = tokens.map(t => ethers.getAddress(t));
  return ethers.solidityPacked(
    ['address', 'uint24', 'address', 'uint24', 'address', 'uint24', 'address'],
    [t0, fees[0], t1, fees[1], t2, fees[2], t0]
  );
}
