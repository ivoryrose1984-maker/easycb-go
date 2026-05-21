// src/config/constants.ts
import 'dotenv/config';

export const CONFIG = {
  CHAIN_ID: 11155111,

  MULTICALL3:    '0xcA11bde05977b3631167028862bE2a173976CA11',
  UNI_FACTORY:   '0x0227628f3F023bb0B980b67D528571c95c6DaC1c',
  UNI_QUOTER_V2: '0xEd1f6473345F45b75833fd55D191EaA7d3F516A5',
  UNI_ROUTER:    '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',
  // Sushi does not have a live testnet quoter; use a second Uniswap fee tier in tests
  SUSHI_ROUTER:  '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
  AAVE_POOL:     '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
  APEX_FLASH_LOAN: '0x7ef837763674380CFbfa0B9d01F5d2F8e0288944',

  WETH: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
  USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  USDT: '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0',
  DAI:  '0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357',

  MIN_PROFIT_BPS:    50,
  MAX_SPREAD_BPS:  5000,
  MIN_LIQUIDITY_USD: 50000,

  MIN_LOAN_USDC:   500n  * 1_000_000n,
  MAX_LOAN_USDC: 10_000n * 1_000_000n,
  LOAN_STEP_USDC:  500n  * 1_000_000n,
  MAX_TERNARY_ITERS: 8,

  GAS_ESTIMATE:            350_000n,
  MIN_PRIORITY_FEE_GWEI:        5n,
  BASE_FEE_MULTIPLIER:          2n,
  DYNAMIC_PRIORITY_MIN_PCT:    10,
  DYNAMIC_PRIORITY_MAX_PCT:    25,

  MAX_CONCURRENT_CYCLES: 3,
  DEBOUNCE_MS:          50,
  MIN_EXEC_INTERVAL_MS: 1000,

  DRAWDOWN_THRESHOLD: 50,
  GRACE_BLOCKS:        3,

  BUILDERS: [
    { name: 'flashbots', url: 'https://relay-sepolia.flashbots.net', enabled: true },
  ],
  MAINNET_BUILDERS: [
    { name: 'flashbots', url: 'https://relay.flashbots.net',    enabled: true },
    { name: 'titan',     url: 'https://rpc.titanbuilder.xyz',   enabled: true },
    { name: 'beaver',    url: 'https://rpc.beaverbuild.org',    enabled: true },
    { name: 'rsync',     url: 'https://rsync-builder.xyz',      enabled: true },
  ],

  WSS_BASE_DELAY_MS:  1_000,
  WSS_MAX_DELAY_MS:  30_000,
  WSS_MAX_ATTEMPTS:      10,
  WSS_KEEPALIVE_MS:  20_000,

  ETH_PRICE_CACHE_MS:    12_000,
  GAS_FORECAST_CACHE_MS: 12_000,
  BLACKLIST_REFRESH_MS: 300_000,

  FLASH_LOAN_FEE_BPS: 5,

  TELEGRAM_MIN_PROFIT_USD:    10,
  TELEGRAM_ALERT_COOLDOWN_MS: 60_000,

  TRIANGULAR_TOKENS: [
    '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
    '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
    '0xaa8e23fb1079ea71e0a56f48a2aa51851d8433d0',
  ],

  BLACKLIST: new Set<string>(),

  LOG_LEVEL: process.env.DRY_RUN === 'true' ? 'debug' : 'info',
  LOG_OPPORTUNITIES: true,
  LOG_FAILED_SIMULATIONS: false,
};

export function gweiToWei(gwei: bigint): bigint { return gwei * 1_000_000_000n; }
export function weiToGwei(wei: bigint): number  { return Number(wei / 1_000_000_000n); }
export function calculateFlashLoanFee(amount: bigint): bigint {
  return (amount * BigInt(CONFIG.FLASH_LOAN_FEE_BPS)) / 10_000n;
}
export function usdcToUsd(usdc: bigint): number { return Number(usdc) / 1e6; }
export function weiToEth(wei: bigint):   number { return Number(wei)  / 1e18; }

export default CONFIG;
