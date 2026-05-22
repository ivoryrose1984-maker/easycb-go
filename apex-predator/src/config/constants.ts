// src/config/constants.ts
import 'dotenv/config';

// Chain selection: set CHAIN_ID env var to 8453 (Base) or 42161 (Arbitrum) for L2
// Default is Base mainnet for best gas economics
const CHAIN_ID_ENV = parseInt(process.env.CHAIN_ID ?? '8453');

const CHAIN_CONFIGS: Record<number, {
  UNI_FACTORY: string; UNI_QUOTER_V2: string; UNI_ROUTER: string;
  SUSHI_ROUTER: string; AAVE_POOL: string; APEX_FLASH_LOAN: string;
  WETH: string; USDC: string; USDT: string; DAI: string;
  cbBTC?: string; cbETH?: string;
  AERO?: string; USDbC?: string; VIRTUAL?: string; BRETT?: string; TBTC?: string;
  GAS_ESTIMATE: bigint; MIN_PRIORITY_FEE_GWEI: bigint;
  BUILDERS: { name: string; url: string; enabled: boolean }[];
}> = {
  // Base mainnet
  8453: {
    UNI_FACTORY:   '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    UNI_QUOTER_V2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    UNI_ROUTER:    '0x2626664c2603336E57B271c5C0b26F421741e481',
    SUSHI_ROUTER:  '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891',
    AAVE_POOL:     '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    APEX_FLASH_LOAN: process.env.APEX_FLASH_LOAN_BASE ?? '0x0000000000000000000000000000000000000000',
    WETH:  '0x4200000000000000000000000000000000000006',
    USDC:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    USDT:  '0xfde4C96c8593536E31F0E8c0FFF4E4b5770B80EC',
    DAI:   '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    cbBTC:   '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    cbETH:   '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
    AERO:    '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
    USDbC:   '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
    VIRTUAL: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7020',
    BRETT:   '0x532f27101965dd16442E59d40670FaF5eBB142E4',
    TBTC:    '0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b',
    GAS_ESTIMATE:         250_000n,
    MIN_PRIORITY_FEE_GWEI:      1n,
    BUILDERS: [
      { name: 'flashbots', url: 'https://rpc.flashbots.net', enabled: true },
    ],
  },
  // Arbitrum mainnet
  42161: {
    UNI_FACTORY:   '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    UNI_QUOTER_V2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    UNI_ROUTER:    '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    SUSHI_ROUTER:  '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
    AAVE_POOL:     '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    APEX_FLASH_LOAN: process.env.APEX_FLASH_LOAN_ARB ?? '0x0000000000000000000000000000000000000000',
    WETH:  '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    USDC:  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    USDT:  '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    DAI:   '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    GAS_ESTIMATE:         300_000n,
    MIN_PRIORITY_FEE_GWEI:      2n,
    BUILDERS: [
      { name: 'flashbots', url: 'https://rpc.flashbots.net', enabled: true },
    ],
  },
  // Sepolia testnet (fallback)
  11155111: {
    UNI_FACTORY:   '0x0227628f3F023bb0B980b67D528571c95c6DaC1c',
    UNI_QUOTER_V2: '0xEd1f6473345F45b75833fd55D191EaA7d3F516A5',
    UNI_ROUTER:    '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',
    SUSHI_ROUTER:  '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
    AAVE_POOL:     '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
    APEX_FLASH_LOAN: '0x7ef837763674380CFbfa0B9d01F5d2F8e0288944',
    WETH:  '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    USDC:  '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    USDT:  '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0',
    DAI:   '0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357',
    GAS_ESTIMATE:         350_000n,
    MIN_PRIORITY_FEE_GWEI:      5n,
    BUILDERS: [
      { name: 'flashbots', url: 'https://relay-sepolia.flashbots.net', enabled: true },
    ],
  },
};

const chain = CHAIN_CONFIGS[CHAIN_ID_ENV] ?? CHAIN_CONFIGS[8453];

export const CONFIG = {
  CHAIN_ID: CHAIN_ID_ENV,

  MULTICALL3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  ...chain,

  // Loan sizing — large enough for L2 gas economics to make sense
  MIN_LOAN_USDC:    1_000n * 1_000_000n,
  MAX_LOAN_USDC: 100_000n * 1_000_000n,
  LOAN_STEP_USDC:   1_000n * 1_000_000n,
  MAX_TERNARY_ITERS: 8,

  MIN_PROFIT_BPS:    20,   // Lower threshold viable on L2 due to cheap gas
  MAX_SPREAD_BPS:  5000,
  MIN_LIQUIDITY_USD: 10000, // Lower for L2 pools

  BASE_FEE_MULTIPLIER:       2n,
  DYNAMIC_PRIORITY_MIN_PCT: 10,
  DYNAMIC_PRIORITY_MAX_PCT: 25,

  MAX_CONCURRENT_CYCLES: 5,
  MIN_EXEC_INTERVAL_MS:  500,  // Faster on L2
  DEBOUNCE_MS:            50,

  DRAWDOWN_THRESHOLD: 50,
  GRACE_BLOCKS:        3,

  MAINNET_BUILDERS: [
    { name: 'flashbots', url: 'https://relay.flashbots.net',   enabled: true },
    { name: 'titan',     url: 'https://rpc.titanbuilder.xyz',  enabled: true },
    { name: 'beaver',    url: 'https://rpc.beaverbuild.org',   enabled: true },
    { name: 'rsync',     url: 'https://rsync-builder.xyz',     enabled: true },
  ],

  WSS_BASE_DELAY_MS:  1_000,
  WSS_MAX_DELAY_MS:  30_000,
  WSS_MAX_ATTEMPTS:      10,
  WSS_KEEPALIVE_MS:  20_000,

  ETH_PRICE_CACHE_MS:    12_000,
  GAS_FORECAST_CACHE_MS: 12_000,
  BLACKLIST_REFRESH_MS: 300_000,

  FLASH_LOAN_FEE_BPS: 0,  // Balancer V2 charges 0% — no fee deduction needed

  TELEGRAM_MIN_PROFIT_USD:    5,
  TELEGRAM_ALERT_COOLDOWN_MS: 60_000,

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
