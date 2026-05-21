// src/infrastructure/telegramAlert.ts
import TelegramBot from 'node-telegram-bot-api';
import CONFIG, { usdcToUsd } from '../config/constants';

let bot:           TelegramBot | null = null;
let chatId:        string | null = null;
let lastAlertTime  = 0;

export async function initTelegram(): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const id    = process.env.TELEGRAM_CHAT_ID;

  if (!token || !id) {
    console.warn('[TELEGRAM] No credentials — alerts disabled');
    return false;
  }

  try {
    const candidate = new TelegramBot(token, { polling: false });
    await candidate.getMe(); // Validate token before accepting
    bot    = candidate;
    chatId = id;
    console.log('[TELEGRAM] ✅ Alert system initialized');
    return true;
  } catch (error) {
    console.error('[TELEGRAM] Init failed (invalid token?):', error);
    return false;
  }
}

type AlertLevel = 'info' | 'profit' | 'alert' | 'critical';

const EMOJI: Record<AlertLevel, string> = {
  info:     'ℹ️',
  profit:   '💰',
  alert:    '⚠️',
  critical: '🚨',
};

export function sendAlert(message: string, level: AlertLevel = 'info'): void {
  if (!bot || !chatId || level === 'info') return;

  const now = Date.now();
  if (now - lastAlertTime < CONFIG.TELEGRAM_ALERT_COOLDOWN_MS) return;
  lastAlertTime = now;

  const text = `${EMOJI[level]} *${level.toUpperCase()}*\n\n${message}`;
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown' })
    .catch(err => console.error('[TELEGRAM] Send failed:', err));
}

export function alertProfit(profitUsdc: bigint, txHash?: string): void {
  const profitUsd = usdcToUsd(profitUsdc);
  if (profitUsd < CONFIG.TELEGRAM_MIN_PROFIT_USD) return;

  const msg = txHash
    ? `Trade executed: $${profitUsd.toFixed(2)} profit\nTx: ${txHash}`
    : `Opportunity detected: $${profitUsd.toFixed(2)} expected profit`;
  sendAlert(msg, 'profit');
}

export function alertCircuitBreaker(reason: string): void {
  sendAlert(`Circuit breaker triggered: ${reason}`, 'critical');
}

export function alertError(error: string): void {
  sendAlert(`Bot error: ${error}`, 'alert');
}

export function alertDailySummary(stats: {
  opportunities: number;
  trades:        number;
  totalProfit:   number;
  successRate:   number;
}): void {
  sendAlert(
    `📊 *Daily Summary*\n\nOpportunities: ${stats.opportunities}\nTrades: ${stats.trades}\nProfit: $${stats.totalProfit.toFixed(2)}\nSuccess: ${(stats.successRate * 100).toFixed(1)}%`,
    'info'
  );
}

export default { initTelegram, sendAlert, alertProfit, alertCircuitBreaker, alertError, alertDailySummary };
