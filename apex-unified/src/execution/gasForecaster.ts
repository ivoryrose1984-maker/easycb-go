import { ethers } from 'ethers';
import CONFIG, { gweiToWei, weiToGwei } from '../core/config';
import { logger } from '../core/logger';

export interface GasForecast {
  predictedBaseFee:   bigint;
  predictedPriority:  bigint;
  volatility:         number;
  dynamicPriorityPct: number;
  lastUpdate:         number;
}

let cache:        GasForecast | null = null;
let cacheTime = 0;

export async function getGasForecast(provider: ethers.Provider, lookback = 10): Promise<GasForecast> {
  const now = Date.now();
  if (cache && now - cacheTime < CONFIG.GAS_FORECAST_CACHE_MS) return cache;

  try {
    const latest = await provider.getBlock('latest');
    if (!latest?.baseFeePerGas) return getDefault();

    const nums   = Array.from({ length: lookback }, (_, i) => latest.number - i);
    const blocks = await Promise.all(nums.map(n => provider.getBlock(n)));
    const fees   = blocks.filter(b => b?.baseFeePerGas).map(b => b!.baseFeePerGas!);
    if (fees.length === 0) return getDefault();

    const avg  = fees.reduce((a, v) => a + v, 0n) / BigInt(fees.length);
    const max  = fees.reduce((m, v) => v > m ? v : m, fees[0]);
    const vol  = calcVolatility(fees, avg);
    const dynPct = Math.round(
      CONFIG.DYNAMIC_PRIORITY_MIN_PCT + vol * (CONFIG.DYNAMIC_PRIORITY_MAX_PCT - CONFIG.DYNAMIC_PRIORITY_MIN_PCT)
    );

    cache     = { predictedBaseFee: max, predictedPriority: gweiToWei(CONFIG.MIN_PRIORITY_FEE_GWEI), volatility: vol, dynamicPriorityPct: dynPct, lastUpdate: now };
    cacheTime = now;
    logger.debug('GAS', `base=${weiToGwei(max)}gwei vol=${(vol * 100).toFixed(1)}% dynPct=${dynPct}%`);
    return cache;
  } catch (err: any) {
    logger.error('GAS', `Forecast failed: ${err.message}`);
    return getDefault();
  }
}

function getDefault(): GasForecast {
  return {
    predictedBaseFee:   gweiToWei(1n),
    predictedPriority:  gweiToWei(CONFIG.MIN_PRIORITY_FEE_GWEI),
    volatility:         0.5,
    dynamicPriorityPct: 15,
    lastUpdate:         Date.now(),
  };
}

function calcVolatility(values: bigint[], avg: bigint): number {
  if (values.length < 2) return 0;
  const a = Number(avg);
  if (a > Number.MAX_SAFE_INTEGER) return 0.5;
  const variance = values.reduce((s, v) => { const d = Number(v) - a; return s + d * d; }, 0) / values.length;
  return Math.min(Math.sqrt(variance) / (a || 1) * 2, 1);
}
