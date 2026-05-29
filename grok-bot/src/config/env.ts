import * as dotenv from 'dotenv';
import { randomUUID } from 'crypto';
dotenv.config();

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const ENV = {
  // Network
  ALCHEMY_WSS_URL: required('ALCHEMY_WSS_URL'),

  // Safety — fail closed
  DRY_RUN:    process.env.DRY_RUN   !== 'false',   // true unless explicitly 'false'
  ALLOW_LIVE: process.env.ALLOW_LIVE === 'true',    // false unless explicitly 'true'
  CHAIN_ID:   8453 as const,

  // Identity
  BOT_ID:      optional('BOT_ID',      'grok-bot'),
  STRATEGY_ID: optional('STRATEGY_ID', 'cbeth_fair_value_base'),
  RUN_ID:      optional('RUN_ID',      randomUUID()),

  // Thresholds
  MIN_NET_EDGE_BPS: parseInt(optional('MIN_NET_EDGE_BPS', '5'),  10),
  CEX_TRIGGER_BPS:  parseInt(optional('CEX_TRIGGER_BPS',  '15'), 10),

  // Optional services
  SUPABASE_URL:      process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID,
} as const;
