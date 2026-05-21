// src/infrastructure/gasForecaster.ts
import { ethers } from 'ethers';
import CONFIG, { weiToGwei, gweiToWei } from '../config/constants';

export interface GasForecast {
  predictedBaseFee:   bigint;
  predictedPriority:  bigint;
  volatility:         number;  // 0–1
  dynamicPriorityPct: number;  // 10–25
  lastUpdate:         number;
}

let forecastCache:    GasForecast | null = null;
let lastForecastTime = 0;

export async function getGasForecast(
  provider:       ethers.Provider,
  lookbackBlocks = 10
): Promise<GasForecast> {
  const now = Date.now();
  if (forecastCache && now - lastForecastTime < CONFIG.GAS_FORECAST_CACHE_MS) {
    return forecastCache;
  }

  try {
    const latestBlock = await provider.getBlock('latest');
    if (!latestBlock?.baseFeePerGas) {
      console.warn('[GAS] Latest block missing baseFeePerGas — using default');
      return getDefaultForecast();
    }

    const blockNums = Array.from({ length: lookbackBlocks }, (_, i) => latestBlock.number - i);
    const blocks    = await Promise.all(blockNums.map(n => provider.getBlock(n)));
    const baseFees  = blocks.filter(b => b?.baseFeePerGas).map(b => b!.baseFeePerGas!);

    if (baseFees.length === 0) return getDefaultForecast();

    const avgBaseFee  = average(baseFees);
    const maxBaseFee  = baseFees.reduce((m, v) => v > m ? v : m, baseFees[0]);
    const volatility  = calculateVolatility(baseFees, avgBaseFee);

    // Use max of recent blocks for next-block prediction — more conservative than avg*1.2
    // and more accurate when network is congested
    const predictedBaseFee = maxBaseFee;

    const dynamicPriorityPct = Math.round(
      CONFIG.DYNAMIC_PRIORITY_MIN_PCT +
      volatility * (CONFIG.DYNAMIC_PRIORITY_MAX_PCT - CONFIG.DYNAMIC_PRIORITY_MIN_PCT)
    );

    const forecast: GasForecast = {
      predictedBaseFee,
      predictedPriority: gweiToWei(CONFIG.MIN_PRIORITY_FEE_GWEI),
      volatility,
      dynamicPriorityPct,
      lastUpdate: now,
    };

    forecastCache    = forecast;
    lastForecastTime = now;

    if (CONFIG.LOG_LEVEL === 'debug') {
      console.log(
        `[GAS] base=${weiToGwei(predictedBaseFee)} gwei, vol=${(volatility * 100).toFixed(1)}%, priority=${dynamicPriorityPct}%`
      );
    }

    return forecast;
  } catch (error) {
    console.error('[GAS] Forecast error:', error);
    return getDefaultForecast();
  }
}

function getDefaultForecast(): GasForecast {
  return {
    predictedBaseFee:   gweiToWei(1n),  // Base L2 is ~0.001-0.1 gwei; 1 gwei is a safe fallback
    predictedPriority:  gweiToWei(CONFIG.MIN_PRIORITY_FEE_GWEI),
    volatility:         0.5,
    dynamicPriorityPct: 15,
    lastUpdate:         Date.now(),
  };
}

function average(values: bigint[]): bigint {
  if (values.length === 0) return 0n;
  return values.reduce((a, v) => a + v, 0n) / BigInt(values.length);
}

function calculateVolatility(values: bigint[], avg: bigint): number {
  if (values.length < 2) return 0;

  const avgNumber = Number(avg);
  if (avgNumber > Number.MAX_SAFE_INTEGER) {
    console.warn('[GAS] Base fee too large for volatility calc — using default');
    return 0.5;
  }

  const variance = values.reduce((sum, v) => {
    const diff = Number(v) - avgNumber;
    return sum + diff * diff;
  }, 0) / values.length;

  const stdDev = Math.sqrt(variance);
  const cv     = avgNumber > 0 ? stdDev / avgNumber : 0;
  return Math.min(cv * 2, 1);
}

export default getGasForecast;
