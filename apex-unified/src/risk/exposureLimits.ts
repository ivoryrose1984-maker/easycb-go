import CONFIG from '../core/config';
import { logger } from '../core/logger';

let activeExposureUsd = 0;

export function checkExposure(newTradeUsd: number): { allowed: boolean; reason: string } {
  if (activeExposureUsd + newTradeUsd > CONFIG.MAX_TRADE_USD) {
    return {
      allowed: false,
      reason:  `Exposure $${(activeExposureUsd + newTradeUsd).toFixed(0)} would exceed MAX_TRADE_USD $${CONFIG.MAX_TRADE_USD}`,
    };
  }
  return { allowed: true, reason: 'Within exposure limits' };
}

export function addExposure(usd: number): void {
  activeExposureUsd += usd;
  logger.debug('EXPOSURE', `Active: $${activeExposureUsd.toFixed(0)}`);
}

export function releaseExposure(usd: number): void {
  activeExposureUsd = Math.max(0, activeExposureUsd - usd);
}

export function getActiveExposure(): number {
  return activeExposureUsd;
}
