import * as dotenv from 'dotenv';
import { randomUUID } from 'crypto';

dotenv.config();

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function flag(key: string, defaultValue: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return defaultValue;
  return v !== 'false' && v !== '0';
}

export const CONFIG = {
  // Identity
  BOT_ID:      optional('BOT_ID',      'apex-unified'),
  RUN_ID:      optional('RUN_ID',      randomUUID()),
  STRATEGY_ID: optional('STRATEGY_ID', 'apex.dex_spread'),

  // Safety — fail closed
  DRY_RUN:    process.env.DRY_RUN    !== 'false',
  ALLOW_LIVE: process.env.ALLOW_LIVE === 'true',

  // Network
  CHAIN_ID:           parseInt(optional('CHAIN_ID', '8453'), 10) as 8453,
  ALCHEMY_WSS_URL:    required('ALCHEMY_WSS_URL'),
  BASE_HTTPS_URL:     optional('BASE_HTTPS_URL',  ''),   // single HTTPS endpoint
  BASE_HTTPS_URLS:    optional('BASE_HTTPS_URLS', ''),   // comma-separated list (takes priority)
  BASE_SEQUENCER_URL: 'https://mainnet.base.org',

  // Strategy feature flags
  ENABLE_DEX_SPREAD_SIGNAL:    flag('ENABLE_DEX_SPREAD_SIGNAL',    true),
  ENABLE_TRIANGULAR_SIGNAL:    flag('ENABLE_TRIANGULAR_SIGNAL',    true),
  ENABLE_CBETH_SIGNAL:         flag('ENABLE_CBETH_SIGNAL',         true),
  ENABLE_AERODROME_SIGNAL:     flag('ENABLE_AERODROME_SIGNAL',     true),
  ENABLE_CEX_CONTEXT:          flag('ENABLE_CEX_CONTEXT',          true),
  // Binance feed — default false: Hetzner/VPS IPs are geo-blocked (HTTP 451).
  // Set true only when running from a region with Binance access.
  ENABLE_BINANCE:              flag('ENABLE_BINANCE',               false),
  ENABLE_FLASH_LOAN_PLANNER:   flag('ENABLE_FLASH_LOAN_PLANNER',   true),
  ENABLE_BUILDER_SUBMISSION:   flag('ENABLE_BUILDER_SUBMISSION',   false),

  // Risk limits
  MAX_TRADE_USD:         parseInt(optional('MAX_TRADE_USD',          '50000'), 10),
  MAX_DAILY_LOSS_USD:    parseInt(optional('MAX_DAILY_LOSS_USD',     '500'),   10),
  MAX_PER_TRADE_LOSS_USD: parseInt(optional('MAX_PER_TRADE_LOSS_USD', '100'),  10),
  MIN_NET_EDGE_BPS:      parseInt(optional('MIN_NET_EDGE_BPS',       '5'),     10),
  CEX_TRIGGER_BPS:       parseInt(optional('CEX_TRIGGER_BPS',        '15'),    10),
  DRAWDOWN_THRESHOLD:    parseFloat(optional('DRAWDOWN_THRESHOLD',    '50')),  // % balance drawdown to trigger circuit breaker (last-resort safeguard)

  // Liquidity filter — reject thin pools before counting as opportunities
  LIQUIDITY_CHECK_SCALE:    parseInt(optional('LIQUIDITY_CHECK_SCALE',    '10'),   10),
  LIQUIDITY_MAX_IMPACT_BPS: parseInt(optional('LIQUIDITY_MAX_IMPACT_BPS', '5000'), 10),

  // Chain addresses — Base mainnet
  TOKENS: {
    WETH:  '0x4200000000000000000000000000000000000006',
    USDC:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    USDT:  '0xfde4C96c8593536E31F0E8c0FFF4E4b5770B80EC',
    DAI:   '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    cbETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
    cbBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
    AERO:  '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
  },

  CONTRACTS: {
    UNI_FACTORY:       '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',  // Uniswap V3 Factory — Base mainnet
    UNI_QUOTER:        '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    UNI_ROUTER:        '0x2626664c2603336E57B271c5C0b26F421741e481',
    CAKE_FACTORY:      '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', // PancakeSwap V3 Factory — Base mainnet
    CAKE_QUOTER:       '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
    CAKE_ROUTER:       '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
    AERODROME_ROUTER:  '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
    AERODROME_FACTORY: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
    APEX_FLASH_LOAN:   process.env.APEX_FLASH_LOAN_BASE ?? '0x0000000000000000000000000000000000000000',
  },

  // Base-compatible submission targets (ENABLE_BUILDER_SUBMISSION=false by default)
  // Base uses a centralized Coinbase sequencer — direct RPC is correct for most cases
  BUILDERS: [
    { name: 'base-sequencer', url: 'https://mainnet.base.org',        enabled: true  },
    { name: 'mev-share',      url: 'https://mev-share.flashbots.net', enabled: false },
    { name: 'bloxroute',      url: 'https://virginia.eth.blxrbdn.com',enabled: false },
    { name: 'titan',          url: 'https://rpc.titanbuilder.xyz',    enabled: false },
  ],

  // Sizing
  MIN_LOAN_USDC:      1_000n * 1_000_000n,
  MAX_LOAN_USDC:     50_000n * 1_000_000n,
  MIN_LOAN_WETH:      500_000_000_000_000_000n,   // 0.5 ETH in wei
  MAX_LOAN_WETH:   30_000_000_000_000_000_000n,   // 30 ETH in wei
  MIN_LOAN_DAI:  1_000_000_000_000_000_000_000n,  // 1,000 DAI in wei (18 dec)
  MAX_LOAN_DAI: 50_000_000_000_000_000_000_000n,  // 50,000 DAI in wei (18 dec)
  MAX_TERNARY_ITERS: 8,
  MIN_PROFIT_BPS:    20,
  MAX_CONCURRENT_CYCLES: 5,

  // Gas
  GAS_ESTIMATE:              250_000n,
  TX_GAS_LIMIT:              600_000n,
  MIN_PRIORITY_FEE_GWEI:     1n,
  BASE_FEE_MULTIPLIER:       2n,
  DYNAMIC_PRIORITY_MIN_PCT:  10,
  DYNAMIC_PRIORITY_MAX_PCT:  25,
  LATENCY_BUFFER_BPS:        5,
  FAILURE_BUFFER_BPS:        5,
  FLASH_LOAN_FEE_BPS:        0,

  // Cache TTLs
  ETH_PRICE_CACHE_MS:    12_000,
  GAS_FORECAST_CACHE_MS: 12_000,

  // Infra
  SUPABASE_URL:          process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY:     process.env.SUPABASE_ANON_KEY,
  TELEGRAM_BOT_TOKEN:    process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID:      process.env.TELEGRAM_CHAT_ID,

  // Reporting — exclude all events before this timestamp from every figure
  CLEAN_DATA_SINCE: optional('CLEAN_DATA_SINCE', '2026-06-12T16:05:00Z'),
  LOG_LEVEL: process.env.LOG_LEVEL ?? (process.env.DRY_RUN !== 'false' ? 'debug' : 'info'),
} as const;

export function gweiToWei(gwei: bigint): bigint { return gwei * 1_000_000_000n; }
export function weiToGwei(wei: bigint): number  { return Number(wei / 1_000_000_000n); }
export function usdcToUsd(usdc: bigint): number { return Number(usdc) / 1e6; }
export function weiToEth(wei: bigint): number   { return Number(wei)  / 1e18; }

export default CONFIG;
