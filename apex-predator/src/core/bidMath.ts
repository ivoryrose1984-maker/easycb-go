// src/core/bidMath.ts
import CONFIG, { calculateFlashLoanFee } from '../config/constants';
import { GasForecast } from '../infrastructure/gasForecaster';

export interface ProfitResult {
  netProfit:           bigint;
  score:               number;
  shouldExecute:       boolean;
  gasCostWei:          bigint;
  priorityFeePerGas:   bigint;  // Per-gas value (for tx field)
  priorityFeeTotalWei: bigint;  // Total wei cost
  maxFeePerGas:        bigint;
  slippageEstimateBps: number;
}

export function calculateNetProfit(
  amountIn:    bigint,  // USDC (6 dec)
  buyQuote:    bigint,  // tokenOut received — used for slippage model
  sellQuote:   bigint,  // USDC back
  gasForecast: GasForecast,
  ethPriceUsd: bigint   // USDC (6 dec) per ETH
): ProfitResult {

  const flashLoanFee = calculateFlashLoanFee(amountIn);
  const grossProfit  = sellQuote - amountIn;

  // Gas cost in USDC: (gasUnits * baseFee) / 1e18 * ethPrice
  const estimatedGasCostWei = CONFIG.GAS_ESTIMATE *
    (gasForecast.predictedBaseFee + CONFIG.MIN_PRIORITY_FEE_GWEI * 1_000_000_000n);
  const gasCostUsdc = (estimatedGasCostWei * ethPriceUsd) / (10n ** 18n);

  // Priority budget: 10-25% of gross profit, scales with volatility
  const priorityFeePct      = BigInt(gasForecast.dynamicPriorityPct); // integer 10-25
  const priorityBudgetUsdc  = grossProfit > 0n
    ? (grossProfit * priorityFeePct) / 100n
    : 0n;

  const netProfit = grossProfit - flashLoanFee - gasCostUsdc - priorityBudgetUsdc;

  const score = amountIn > 0n
    ? Number((netProfit * 10_000n) / amountIn)
    : 0;

  const shouldExecute =
    netProfit > 0n &&
    score >= CONFIG.MIN_PROFIT_BPS &&
    grossProfit > gasCostUsdc + flashLoanFee;

  // Convert USDC priority budget → wei, then to per-gas
  const priorityBudgetWei = ethPriceUsd > 0n
    ? (priorityBudgetUsdc * (10n ** 18n)) / ethPriceUsd
    : CONFIG.MIN_PRIORITY_FEE_GWEI * 1_000_000_000n;

  const rawPriorityPerGas = CONFIG.GAS_ESTIMATE > 0n
    ? priorityBudgetWei / CONFIG.GAS_ESTIMATE
    : 0n;

  const minPriority = CONFIG.MIN_PRIORITY_FEE_GWEI * 1_000_000_000n;
  const priorityFeePerGas  = rawPriorityPerGas > minPriority ? rawPriorityPerGas : minPriority;
  const priorityFeeTotalWei = priorityFeePerGas * CONFIG.GAS_ESTIMATE;

  const maxFeePerGas = (gasForecast.predictedBaseFee * CONFIG.BASE_FEE_MULTIPLIER) + priorityFeePerGas;

  // Slippage: sqrt(tradeSize/1e12) * 10, capped at 250 bps
  const slippageEstimateBps = Math.min(
    Math.round(Math.sqrt(Number(amountIn) / 1e12) * 10),
    250
  );

  return {
    netProfit,
    score,
    shouldExecute,
    gasCostWei:          estimatedGasCostWei,
    priorityFeePerGas,
    priorityFeeTotalWei,
    maxFeePerGas,
    slippageEstimateBps,
  };
}

export async function findOptimalLoanSize(
  calculateProfitFn: (amount: bigint) => Promise<ProfitResult>,
  minAmount = CONFIG.MIN_LOAN_USDC,
  maxAmount = CONFIG.MAX_LOAN_USDC,
  iterations = CONFIG.MAX_TERNARY_ITERS
): Promise<{ optimalAmount: bigint; maxProfit: ProfitResult }> {
  let left  = minAmount;
  let right = maxAmount;

  for (let i = 0; i < iterations; i++) {
    const mid1 = left  + (right - left) / 3n;
    const mid2 = right - (right - left) / 3n;
    const [r1, r2] = await Promise.all([
      calculateProfitFn(mid1),
      calculateProfitFn(mid2),
    ]);
    if (r1.netProfit > r2.netProfit) right = mid2;
    else                              left  = mid1;
  }

  const optimalAmount = (left + right) / 2n;
  const maxProfit     = await calculateProfitFn(optimalAmount);
  return { optimalAmount, maxProfit };
}

export default { calculateNetProfit, findOptimalLoanSize };
