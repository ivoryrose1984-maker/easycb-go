// src/config/l2-configs.ts
// Layer 2 network configurations for Base and Arbitrum

export const BASE_CONFIG = {
  CHAIN_ID:   8453,
  CHAIN_NAME: 'Base',
  RPC_URL:    'https://mainnet.base.org',
  WSS_URL:    'wss://base-mainnet.g.alchemy.com/v2/YOUR_KEY',

  MULTICALL3:    '0xcA11bde05977b3631167028862bE2a173976CA11',
  UNI_FACTORY:   '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  UNI_QUOTER_V2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  UNI_ROUTER:    '0x2626664c2603336E57B271c5C0b26F421741e481',
  AAVE_POOL:     '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  AERODROME_ROUTER: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
  BASESWAP_ROUTER:  '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86',

  WETH: '0x4200000000000000000000000000000000000006',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDT: '0xfde4C96c8593536E31F0E8c0FFF4E4b5770B80EC',
  DAI:  '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',

  GAS_ESTIMATE:         250_000n,
  MIN_PRIORITY_FEE_GWEI:      1n,
  // Stored as [num, den] to avoid bigint truncation: 3/2 = 1.5x
  BASE_FEE_MULTIPLIER_NUM: 3n,
  BASE_FEE_MULTIPLIER_DEN: 2n,

  MIN_PROFIT_BPS:   20,
  MIN_LOAN_USDC:   100n * 1_000_000n,
  MAX_LOAN_USDC: 50_000n * 1_000_000n,

  BUILDERS: [
    { name: 'flashbots', url: 'https://rpc.flashbots.net', enabled: true },
  ],
};

export const ARBITRUM_CONFIG = {
  CHAIN_ID:   42161,
  CHAIN_NAME: 'Arbitrum',
  RPC_URL:    'https://arb1.arbitrum.io/rpc',
  WSS_URL:    'wss://arb-mainnet.g.alchemy.com/v2/YOUR_KEY',

  MULTICALL3:    '0xcA11bde05977b3631167028862bE2a173976CA11',
  UNI_FACTORY:   '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  UNI_QUOTER_V2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  UNI_ROUTER:    '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  SUSHI_ROUTER:  '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
  AAVE_POOL:     '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  CAMELOT_ROUTER:  '0xc873fEcbd354f5A56E00E710B90EF4201db2448d',
  TRADERJOE_ROUTER:'0xb4315e873dBcf96Ffd0acd8EA43f689D8c20fB30',

  WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  DAI:  '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',

  GAS_ESTIMATE:         300_000n,
  MIN_PRIORITY_FEE_GWEI:      2n,
  BASE_FEE_MULTIPLIER_NUM: 3n,
  BASE_FEE_MULTIPLIER_DEN: 2n,

  MIN_PROFIT_BPS:   25,
  MIN_LOAN_USDC:    200n * 1_000_000n,
  MAX_LOAN_USDC: 100_000n * 1_000_000n,

  BUILDERS: [
    { name: 'flashbots', url: 'https://rpc.flashbots.net', enabled: true },
  ],
};

export function getChainConfig(chainId: number) {
  switch (chainId) {
    case 8453:  return BASE_CONFIG;
    case 42161: return ARBITRUM_CONFIG;
    default:    throw new Error(`Unsupported chain ID: ${chainId}`);
  }
}

export const GAS_ECONOMICS = {
  ETHEREUM: {
    avgGasPrice:      30n * 1_000_000_000n,
    arbitrageCost:    '~$15-30 per trade',
    minProfitNeeded:  '$50+',
  },
  BASE: {
    avgGasPrice:      10_000_000n,
    arbitrageCost:    '~$0.01-0.05 per trade',
    minProfitNeeded:  '$2+',
  },
  ARBITRUM: {
    avgGasPrice:      100_000_000n,
    arbitrageCost:    '~$0.10-0.50 per trade',
    minProfitNeeded:  '$5+',
  },
};

export default { BASE_CONFIG, ARBITRUM_CONFIG, getChainConfig, GAS_ECONOMICS };
