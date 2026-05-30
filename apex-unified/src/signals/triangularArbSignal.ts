import { ethers }   from 'ethers';
import { createHash } from 'crypto';
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

const STABLE = new Set([
  CONFIG.TOKENS.USDC.toLowerCase(),
  CONFIG.TOKENS.USDT.toLowerCase(),
  CONFIG.TOKENS.DAI.toLowerCase(),
  CONFIG.TOKENS.USDbC.toLowerCase(),
]);
const MAJOR = new Set([
  CONFIG.TOKENS.WETH.toLowerCase(),
  CONFIG.TOKENS.cbBTC.toLowerCase(),
  CONFIG.TOKENS.cbETH.toLowerCase(),
]);

function feeTiers(a: string, b: string): number[] {
  if (STABLE.has(a.toLowerCase()) && STABLE.has(b.toLowerCase())) return [100, 500];
  if (STABLE.has(a.toLowerCase()) || STABLE.has(b.toLowerCase()))  return [500, 3000];
  if (MAJOR.has(a.toLowerCase())  && MAJOR.has(b.toLowerCase()))   return [500, 3000];
  return [3000];
}

function buildCandidates(): PathCandidate[] {
  const base   = CONFIG.TOKENS.USDC;
  const others = [
    CONFIG.TOKENS.WETH, CONFIG.TOKENS.USDT, CONFIG.TOKENS.DAI,
    CONFIG.TOKENS.cbETH, CONFIG.TOKENS.cbBTC, CONFIG.TOKENS.AERO,
  ].filter(Boolean);

  const out: PathCandidate[] = [];
  for (let i = 0; i < others.length; i++) {
    const mid = others[i];
    for (let j = 0; j < others.length; j++) {
      if (i === j) continue;
      const end = others[j];
      for (const f1 of feeTiers(base, mid)) {
        for (const f2 of feeTiers(mid, end)) {
          for (const f3 of feeTiers(end, base)) {
            out.push({ tokens: [base, mid, end], fees: [f1, f2, f3] });
          }
        }
      }
    }
  }
  return out;
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

  async scan(amountIn: bigint, blockNumber: number): Promise<TriangularResult[]> {
    const results = await Promise.allSettled(
      CANDIDATES.map(c => this.simulate(c.tokens, c.fees, amountIn, blockNumber))
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
    tokens:   [string, string, string],
    fees:     [number, number, number],
    amountIn: bigint,
    blockNumber: number
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
        netProfitUsd:     0,
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
