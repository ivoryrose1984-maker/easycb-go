import CONFIG from '../core/config';
import { GasForecast } from './gasForecaster';
import { gweiToWei } from '../core/config';

export interface ProfitResult {
  netProfit:           bigint;
  score:               number;
  shouldExecute:       boolean;
  gasCostWei:          bigint;
  maxFeePerGas:        bigint;
  priorityFeePerGas:   bigint;
  slippageEstimateBps: number;
}

export function calculateNetProfit(
  amountIn:    bigint,
  buyQuote:    bigint,
  sellQuote:   bigint,
  gasForecast: GasForecast,
  ethPriceUsd: bigint
): ProfitResult {
  const grossProfit = sellQuote - amountIn;
  const gasCostWei  = CONFIG.GAS_ESTIMATE *
    (gasForecast.predictedBaseFee + CONFIG.MIN_PRIORITY_FEE_GWEI * 1_000_000_000n);
  const gasCostUsdc = (gasCostWei * ethPriceUsd) / 10n ** 18n;

  const priorityPct     = BigInt(gasForecast.dynamicPriorityPct);
  const priorityBudget  = grossProfit > 0n ? (grossProfit * priorityPct) / 100n : 0n;

  const latencyCost  = amountIn > 0n ? (amountIn * BigInt(CONFIG.LATENCY_BUFFER_BPS))  / 10_000n : 0n;
  const failureCost  = amountIn > 0n ? (amountIn * BigInt(CONFIG.FAILURE_BUFFER_BPS))  / 10_000n : 0n;

  const netProfit = grossProfit - gasCostUsdc - priorityBudget - latencyCost - failureCost;
  const score     = amountIn > 0n ? Number((netProfit * 10_000n) / amountIn) : 0;

  const shouldExecute = netProfit > 0n && score >= CONFIG.MIN_PROFIT_BPS && grossProfit > gasCostUsdc;

  const priorityWei    = ethPriceUsd > 0n ? (priorityBudget * 10n ** 18n) / ethPriceUsd : gweiToWei(CONFIG.MIN_PRIORITY_FEE_GWEI);
  const priorityPerGas = CONFIG.GAS_ESTIMATE > 0n ? priorityWei / CONFIG.GAS_ESTIMATE : 0n;
  const minPriority    = CONFIG.MIN_PRIORITY_FEE_GWEI * 1_000_000_000n;
  const priorityFeePerGas = priorityPerGas > minPriority ? priorityPerGas : minPriority;
  const maxFeePerGas      = gasForecast.predictedBaseFee * CONFIG.BASE_FEE_MULTIPLIER + priorityFeePerGas;

  const slippageEstimateBps = Math.min(250, Math.round(Math.sqrt(Number(amountIn) / 1e12) * 10));

  return { netProfit, score, shouldExecute, gasCostWei, maxFeePerGas, priorityFeePerGas, slippageEstimateBps };
}

export async function findOptimalLoanSize(
  fn:    (amount: bigint) => Promise<ProfitResult>,
  min  = CONFIG.MIN_LOAN_USDC,
  max  = CONFIG.MAX_LOAN_USDC,
  iters = CONFIG.MAX_TERNARY_ITERS
): Promise<{ optimalAmount: bigint; maxProfit: ProfitResult }> {
  let left = min, right = max;
  for (let i = 0; i < iters; i++) {
    const m1 = left + (right - left) / 3n;
    const m2 = right - (right - left) / 3n;
    const [r1, r2] = await Promise.all([fn(m1), fn(m2)]);
    if (r1.netProfit > r2.netProfit) right = m2;
    else                              left  = m1;
  }
  const optimalAmount = (left + right) / 2n;
  return { optimalAmount, maxProfit: await fn(optimalAmount) };
}
