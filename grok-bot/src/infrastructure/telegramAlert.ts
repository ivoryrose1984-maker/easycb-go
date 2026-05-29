import TelegramBot from 'node-telegram-bot-api';
import { ENV } from '../config/env';

let bot:    TelegramBot | null = null;
let chatId: string | null      = null;
let lastSentMs = 0;
const COOLDOWN_MS = 60_000;

export async function initTelegram(): Promise<void> {
  if (!ENV.TELEGRAM_BOT_TOKEN || !ENV.TELEGRAM_CHAT_ID) {
    console.warn('[TG] No credentials — alerts disabled');
    return;
  }
  try {
    const candidate = new TelegramBot(ENV.TELEGRAM_BOT_TOKEN, { polling: false });
    await candidate.getMe();
    bot    = candidate;
    chatId = ENV.TELEGRAM_CHAT_ID;
    console.log('[TG] ✅ Alerts enabled');
  } catch (err) {
    console.error('[TG] Init failed:', (err as Error).message);
  }
}

export function sendAlert(text: string): void {
  if (!bot || !chatId) return;
  if (Date.now() - lastSentMs < COOLDOWN_MS) return;
  lastSentMs = Date.now();
  bot.sendMessage(chatId, `🤖 *GrokBot*\n\n${text}`, { parse_mode: 'Markdown' })
     .catch(err => console.error('[TG] Send failed:', err));
}
