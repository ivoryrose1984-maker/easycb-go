import TelegramBot from 'node-telegram-bot-api';
import CONFIG from '../core/config';
import { logger } from '../core/logger';

let bot:        TelegramBot | null = null;
let chatId:     string | null      = null;
let lastSentMs = 0;
const COOLDOWN = 60_000;

// HTML mode is used for all messages — escape &, <, > so dynamic values
// (token symbols, strategy IDs, dollar amounts) can never break parsing.
function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function initTelegram(): Promise<void> {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
    logger.warn('TG', 'No credentials — alerts disabled');
    return;
  }
  try {
    const candidate = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: false });
    await candidate.getMe(); // validates token
    // Probe chat_id with a real send — getMe() only validates the token, not the chat
    await candidate.sendMessage(CONFIG.TELEGRAM_CHAT_ID,
      `🤖 <b>ApexUnified</b>\n\nBot started — alerts active`, { parse_mode: 'HTML' });
    bot       = candidate;
    chatId    = CONFIG.TELEGRAM_CHAT_ID;
    lastSentMs = Date.now();
    logger.info('TG', 'Alerts enabled and chat_id verified');
  } catch (err: any) {
    logger.warn('TG', `Init failed (alerts disabled): ${err.message}`);
    // bot/chatId remain null — all send functions become no-ops
  }
}

export function sendAlert(text: string): void {
  if (!bot || !chatId) return;
  if (Date.now() - lastSentMs < COOLDOWN) return;
  lastSentMs = Date.now();
  bot.sendMessage(chatId, `🤖 <b>ApexUnified</b>\n\n${esc(text)}`, { parse_mode: 'HTML' })
     .catch(err => logger.error('TG', `Send failed: ${err}`));
}

function sendPriority(text: string): void {
  if (!bot || !chatId) return;
  bot.sendMessage(chatId, `🚨 <b>ApexUnified</b>\n\n${esc(text)}`, { parse_mode: 'HTML' })
     .catch(err => logger.error('TG', `Priority send failed: ${err}`));
}

export function alertOpportunity(strategyId: string, bps: number, blockNum: number): void {
  sendAlert(`Opportunity\nStrategy: ${strategyId}\nSpread: ${bps}bps\nBlock: ${blockNum}`);
}

export function alertCircuitBreaker(msg: string): Promise<void> {
  if (!bot || !chatId) return Promise.resolve();
  return bot
    .sendMessage(chatId, `🚨 <b>ApexUnified</b>\n\nCIRCUIT BREAKER\n${esc(msg)}`, { parse_mode: 'HTML' })
    .then(() => {})
    .catch(err => { logger.error('TG', `Circuit breaker alert failed: ${err}`); });
}

export function alertError(msg: string): void {
  sendPriority(`ERROR\n${msg}`);
}
