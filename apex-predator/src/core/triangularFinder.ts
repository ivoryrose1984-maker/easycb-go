// src/core/triangularFinder.ts
import { ethers } from 'ethers';
import CONFIG from '../config/constants';
import { calculateNetProfit, ProfitResult } from './bidMath';
import { GasForecast } from '../infrastructure/gasForecaster';

export interface TriangularPath {
  tokens:         [string, string, string];
  fees:           [number, number, number];
  dexes:          [string, string, string];
  expectedProfit: bigint;
  profitResult:   ProfitResult;
  quotes:         [bigint, bigint, bigint];
  encodedPath:    string;
}

interface PathTemplate {
  tokens:      [string, string, string];
  fees:        [number, number, number];
  description: string;
}

const PATH_TEMPLATES: PathTemplate[] = [
  { tokens: [CONFIG.USDC, CONFIG.WETH, CONFIG.USDT], fees: [3000, 3000, 3000], description: 'USDC→WETH→USDT→USDC' },
  { tokens: [CONFIG.USDC, CONFIG.USDT, CONFIG.WETH], fees: [500,  3000, 3000], description: 'USDC→USDT→WETH→USDC' },
  { tokens: [CONFIG.USDC, CONFIG.WETH, CONFIG.DAI],  fees: [3000, 3000, 500],  description: 'USDC→WETH→DAI→USDC'  },
];

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160,uint32,uint256)',
];

export async function findTriangularOpportunities(
  provider:     ethers.Provider,
  quoterAddress: string,
  amountIn:     bigint,
  gasForecast:  GasForecast,
  ethPriceUsd:  bigint
): Promise<TriangularPath[]> {

  const quoter = new ethers.Contract(quoterAddress, QUOTER_ABI, provider);

  // Test all path templates in parallel
  const results = await Promise.allSettled(
    PATH_TEMPLATES.map(t =>
      simulateTriangularCycle(quoter, t.tokens, t.fees, amountIn, gasForecast, ethPriceUsd)
        .then(result => ({ result, template: t }))
    )
  );

  const opportunities: TriangularPath[] = [];
  for (const settled of results) {
    if (settled.status !== 'fulfilled' || !settled.value.result) continue;
    const { result, template } = settled.value;
    if (!result.profitResult.shouldExecute) continue;

    opportunities.push({
      ...result,
      fees:        template.fees,
      dexes:       ['uniswap', 'uniswap', 'uniswap'],
      encodedPath: encodeTriangularPath(template.tokens, template.fees),
    });

    if (CONFIG.LOG_LEVEL === 'debug') {
      console.log(`[TRIANGULAR] Found: ${template.description}, score: ${result.profitResult.score} bps`);
    }
  }

  opportunities.sort((a, b) => Number(b.expectedProfit - a.expectedProfit));
  return opportunities;
}

async function simulateTriangularCycle(
  quoter:       ethers.Contract,
  tokens:       [string, string, string],
  fees:         [number, number, number],
  amountIn:     bigint,
  gasForecast:  GasForecast,
  ethPriceUsd:  bigint
): Promise<Omit<TriangularPath, 'fees' | 'dexes' | 'encodedPath'> | null> {

  // Legs are sequential: each leg's output feeds the next
  const quote1 = await quoter.quoteExactInputSingle.staticCall({
    tokenIn: tokens[0], tokenOut: tokens[1], amountIn, fee: fees[0], sqrtPriceLimitX96: 0,
  });
  const amountOut1: bigint = quote1[0];
  if (amountOut1 === 0n) return null;

  const quote2 = await quoter.quoteExactInputSingle.staticCall({
    tokenIn: tokens[1], tokenOut: tokens[2], amountIn: amountOut1, fee: fees[1], sqrtPriceLimitX96: 0,
  });
  const amountOut2: bigint = quote2[0];
  if (amountOut2 === 0n) return null;

  const quote3 = await quoter.quoteExactInputSingle.staticCall({
    tokenIn: tokens[2], tokenOut: tokens[0], amountIn: amountOut2, fee: fees[2], sqrtPriceLimitX96: 0,
  });
  const finalAmount: bigint = quote3[0];
  if (finalAmount === 0n || finalAmount <= amountIn) return null;

  // Both amountIn and finalAmount are in the same token (USDC), so gross profit = finalAmount - amountIn
  const profitResult = calculateNetProfit(
    amountIn,
    amountOut1,   // intermediate, used only for slippage model
    finalAmount,  // back in original token
    gasForecast,
    ethPriceUsd
  );

  return {
    tokens,
    expectedProfit: profitResult.netProfit,
    profitResult,
    quotes: [amountOut1, amountOut2, finalAmount],
  };
}

export function encodeTriangularPath(
  tokens: [string, string, string],
  fees:   [number, number, number]
): string {
  return ethers.solidityPacked(
    ['address', 'uint24', 'address', 'uint24', 'address'],
    [tokens[0], fees[0], tokens[1], fees[1], tokens[2]]
  );
}

export default { findTriangularOpportunities, encodeTriangularPath };
