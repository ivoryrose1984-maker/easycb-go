export const TOKENS = {
  WETH:  '0x4200000000000000000000000000000000000006',
  USDC:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  cbETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
  cbBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
} as const;

export const CONTRACTS = {
  UNISWAP_V3_QUOTER: '0x3d4e44Eb1374240CE5F1B136cf68A4f7C49a5bBf',
  BALANCER_VAULT:    '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
} as const;

export const CBETH_ABI = [
  'function exchangeRate() external view returns (uint256)',
] as const;

export const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
] as const;
