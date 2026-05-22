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

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160,uint32,uint256)',
];

// ── Token category helpers ────────────────────────────────────────────────────
// Used to select probable fee tiers for each leg without brute-forcing all 4^3 = 64 combos.

const STABLE_LOWER = new Set([
  CONFIG.USDC.toLowerCase(),
  CONFIG.USDT.toLowerCase(),
  CONFIG.DAI.toLowerCase(),
  ...(CONFIG.USDbC ? [CONFIG.USDbC.toLowerCase()] : []),
]);

const MAJOR_LOWER = new Set([
  CONFIG.WETH.toLowerCase(),
  ...(CONFIG.cbBTC  ? [CONFIG.cbBTC.toLowerCase()]  : []),
  ...(CONFIG.cbETH  ? [CONFIG.cbETH.toLowerCase()]  : []),
  ...(CONFIG.TBTC   ? [CONFIG.TBTC.toLowerCase()]   : []),
]);

function isStable(addr: string): boolean { return STABLE_LOWER.has(addr.toLowerCase()); }
function isMajor(addr: string):  boolean { return MAJOR_LOWER.has(addr.toLowerCase()); }

// Returns the 1–2 most likely fee tiers for a token pair.
//   stable–stable    → [100, 500]   tightest pools
//   stable–volatile  → [500, 3000]  standard
//   volatile–volatile→ [3000]       widest; alts rarely have 500 pools
function candidateFeeTiers(tokenA: string, tokenB: string): number[] {
  if (isStable(tokenA) && isStable(tokenB)) return [100, 500];
  if (isStable(tokenA) || isStable(tokenB)) return [500, 3000];
  if (isMajor(tokenA)  && isMajor(tokenB))  return [500, 3000]; // e.g. WETH/cbBTC
  return [3000];
}

// ── Candidate path generation ─────────────────────────────────────────────────

interface PathCandidate {
  tokens: [string, string, string];
  fees:   [number, number, number];
}

function buildCandidates(): PathCandidate[] {
  const base = CONFIG.USDC;

  // All non-base tokens available on this chain
  const others: string[] = [CONFIG.WETH, CONFIG.USDT, CONFIG.DAI];
  const optionals: (string | undefined)[] = [
    CONFIG.cbBTC, CONFIG.cbETH, CONFIG.AERO,
    CONFIG.USDbC, CONFIG.VIRTUAL, CONFIG.BRETT, CONFIG.TBTC,
  ];
  for (const t of optionals) { if (t) others.push(t); }

  const out: PathCandidate[] = [];

  for (let i = 0; i < others.length; i++) {
    const mid = others[i];
    for (let j = 0; j < others.length; j++) {
      if (i === j) continue; // mid must differ from end
      const end = others[j];

      const f1s = candidateFeeTiers(base, mid);
      const f2s = candidateFeeTiers(mid,  end);
      const f3s = candidateFeeTiers(end,  base);

      for (const f1 of f1s) {
        for (const f2 of f2s) {
          for (const f3 of f3s) {
            out.push({ tokens: [base, mid, end], fees: [f1, f2, f3] });
          }
        }
      }
    }
  }

  return out;
}

// Computed once at module load — no re-computation per scan.
const CANDIDATES: PathCandidate[] = buildCandidates();

// ── Public API ────────────────────────────────────────────────────────────────

export async function findTriangularOpportunities(
  provider:      ethers.Provider,
  quoterAddress: string,
  amountIn:      bigint,
  gasForecast:   GasForecast,
  ethPriceUsd:   bigint
): Promise<TriangularPath[]> {

  const quoter = new ethers.Contract(quoterAddress, QUOTER_ABI, provider);

  const results = await Promise.allSettled(
    CANDIDATES.map(c =>
      simulateTriangularCycle(quoter, c.tokens, c.fees, amountIn, gasForecast, ethPriceUsd)
        .then(result => (result ? { result, candidate: c } : null))
    )
  );

  const opportunities: TriangularPath[] = [];
  for (const settled of results) {
    if (settled.status !== 'fulfilled' || !settled.value) continue;
    const { result, candidate } = settled.value;
    if (!result.profitResult.shouldExecute) continue;

    opportunities.push({
      ...result,
      fees:        candidate.fees,
      dexes:       ['uniswap', 'uniswap', 'uniswap'],
      encodedPath: encodeTriangularPath(candidate.tokens, candidate.fees),
    });

    if (CONFIG.LOG_LEVEL === 'debug') {
      const [, mid, end] = candidate.tokens;
      console.log(
        `[TRIANGULAR] USDC→${mid.slice(0,8)}→${end.slice(0,8)}→USDC ` +
        `fees=[${candidate.fees}] score=${result.profitResult.score}bps`
      );
    }
  }

  opportunities.sort((a, b) => Number(b.expectedProfit - a.expectedProfit));
  return opportunities;
}

// ── Internal simulation ───────────────────────────────────────────────────────

async function simulateTriangularCycle(
  quoter:      ethers.Contract,
  tokens:      [string, string, string],
  fees:        [number, number, number],
  amountIn:    bigint,
  gasForecast: GasForecast,
  ethPriceUsd: bigint
): Promise<Omit<TriangularPath, 'fees' | 'dexes' | 'encodedPath'> | null> {

  // Leg 1: tokens[0] → tokens[1]
  const quote1 = await quoter.quoteExactInputSingle.staticCall({
    tokenIn: tokens[0], tokenOut: tokens[1], amountIn, fee: fees[0], sqrtPriceLimitX96: 0,
  });
  const amountOut1: bigint = quote1[0];
  if (amountOut1 === 0n) return null;

  // Leg 2: tokens[1] → tokens[2]
  const quote2 = await quoter.quoteExactInputSingle.staticCall({
    tokenIn: tokens[1], tokenOut: tokens[2], amountIn: amountOut1, fee: fees[1], sqrtPriceLimitX96: 0,
  });
  const amountOut2: bigint = quote2[0];
  if (amountOut2 === 0n) return null;

  // Leg 3: tokens[2] → tokens[0]  (closes the cycle)
  const quote3 = await quoter.quoteExactInputSingle.staticCall({
    tokenIn: tokens[2], tokenOut: tokens[0], amountIn: amountOut2, fee: fees[2], sqrtPriceLimitX96: 0,
  });
  const finalAmount: bigint = quote3[0];
  if (finalAmount === 0n || finalAmount <= amountIn) return null;

  // grossProfit = finalAmount - amountIn (both are in the same token, USDC)
  const profitResult = calculateNetProfit(
    amountIn,
    amountOut1,   // intermediate amount, used only for the slippage heuristic
    finalAmount,
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

// ── Path encoding ─────────────────────────────────────────────────────────────

// 3-hop triangular path that closes back to tokens[0]:
//   tokens[0] → tokens[1] → tokens[2] → tokens[0]
// getAddress() normalises to EIP-55 — ethers v6 solidityPacked requires checksummed addresses.
export function encodeTriangularPath(
  tokens: [string, string, string],
  fees:   [number, number, number]
): string {
  const [t0, t1, t2] = tokens.map(t => ethers.getAddress(t.toLowerCase()));
  return ethers.solidityPacked(
    ['address', 'uint24', 'address', 'uint24', 'address', 'uint24', 'address'],
    [t0, fees[0], t1, fees[1], t2, fees[2], t0]
  );
}

// 2-hop path: tokenIn → tokenMid → tokenOut
export function encode2HopPath(
  tokenIn:  string,
  feeBuy:   number,
  tokenMid: string,
  feeSell:  number,
  tokenOut: string
): string {
  const [a, b, c] = [tokenIn, tokenMid, tokenOut].map(t => ethers.getAddress(t.toLowerCase()));
  return ethers.solidityPacked(
    ['address', 'uint24', 'address', 'uint24', 'address'],
    [a, feeBuy, b, feeSell, c]
  );
}

export default { findTriangularOpportunities, encodeTriangularPath, encode2HopPath };
