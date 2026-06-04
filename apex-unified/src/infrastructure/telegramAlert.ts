import TelegramBot from 'node-telegram-bot-api';
import CONFIG from '../core/config';
import { logger } from '../core/logger';

let bot:        TelegramBot | null = null;
let chatId:     string | null      = null;
let lastSentMs = 0;
const COOLDOWN = 60_000;

export async function initTelegram(): Promise<void> {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
    logger.warn('TG', 'No credentials — alerts disabled');
    return;
  }
  try {
    const candidate = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: false });
    await candidate.getMe();
    bot    = candidate;
    chatId = CONFIG.TELEGRAM_CHAT_ID;
    logger.info('TG', 'Alerts enabled');
  } catch (err: any) {
    logger.error('TG', `Init failed: ${err.message}`);
  }
}

export function sendAlert(text: string): void {
  if (!bot || !chatId) return;
  if (Date.now() - lastSentMs < COOLDOWN) return;
  lastSentMs = Date.now();
  bot.sendMessage(chatId, `🤖 *ApexUnified*\n\n${text}`, { parse_mode: 'Markdown' })
     .catch(err => logger.error('TG', `Send failed: ${err}`));
}

function sendPriority(text: string): void {
  if (!bot || !chatId) return;
  // Safety-critical alerts bypass the cooldown
  bot.sendMessage(chatId, `🚨 *ApexUnified*\n\n${text}`, { parse_mode: 'Markdown' })
     .catch(err => logger.error('TG', `Priority send failed: ${err}`));
}

export function alertOpportunity(strategyId: string, bps: number, blockNum: number): void {
  sendAlert(`Opportunity\nStrategy: ${strategyId}\nSpread: ${bps}bps\nBlock: ${blockNum}`);
}

export function alertCircuitBreaker(msg: string): Promise<void> {
  if (!bot || !chatId) return Promise.resolve();
  return bot
    .sendMessage(chatId, `🚨 *ApexUnified*\n\nCIRCUIT BREAKER\n${msg}`, { parse_mode: 'Markdown' })
    .then(() => {})
    .catch(err => { logger.error('TG', `Circuit breaker alert failed: ${err}`); });
}

export function alertError(msg: string): void {
  sendPriority(`ERROR\n${msg}`);
}
