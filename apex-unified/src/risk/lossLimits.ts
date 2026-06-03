import CONFIG from '../core/config';
import { logger } from '../core/logger';

let dailyLossUsd    = 0;
let perTradeLossUsd = 0;
let lastResetDay    = new Date().toDateString();

function checkReset(): void {
  const today = new Date().toDateString();
  if (today !== lastResetDay) {
    dailyLossUsd  = 0;
    lastResetDay  = today;
    logger.info('RISK', 'Daily loss counter reset');
  }
}

export function checkTradeAllowed(estimatedTradeUsd: number, estimatedLossUsd = 0): { allowed: boolean; reason: string } {
  checkReset();

  if (estimatedTradeUsd > CONFIG.MAX_TRADE_USD) {
    return { allowed: false, reason: `Trade $${estimatedTradeUsd} exceeds MAX_TRADE_USD $${CONFIG.MAX_TRADE_USD}` };
  }

  if (estimatedLossUsd > CONFIG.MAX_PER_TRADE_LOSS_USD) {
    return { allowed: false, reason: `Estimated loss $${estimatedLossUsd.toFixed(2)} exceeds MAX_PER_TRADE_LOSS_USD $${CONFIG.MAX_PER_TRADE_LOSS_USD}` };
  }

  if (dailyLossUsd >= CONFIG.MAX_DAILY_LOSS_USD) {
    return { allowed: false, reason: `Daily loss $${dailyLossUsd.toFixed(2)} reached MAX_DAILY_LOSS_USD $${CONFIG.MAX_DAILY_LOSS_USD}` };
  }

  return { allowed: true, reason: 'Within limits' };
}

export function recordLoss(usd: number): void {
  checkReset();
  dailyLossUsd += usd;
  logger.warn('RISK', `Loss recorded: $${usd.toFixed(2)} (daily total: $${dailyLossUsd.toFixed(2)})`);
}

export function getDailyLoss(): number {
  checkReset();
  return dailyLossUsd;
}
