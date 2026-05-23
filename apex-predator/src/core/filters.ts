// src/core/filters.ts
import { ethers } from 'ethers';
import CONFIG from '../config/constants';
import { fetchBlacklist } from '../infrastructure/supabaseLogger';

const POOL_ABI  = ['function liquidity() view returns (uint128)'];
const TOKEN_ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
const FACTORY_ADDRESS = CONFIG.UNI_FACTORY;

export async function isBlacklisted(tokenAddress: string): Promise<boolean> {
  const addr = tokenAddress.toLowerCase();
  if (CONFIG.BLACKLIST.has(addr)) return true;
  const supabaseBlacklist = await fetchBlacklist();
  return supabaseBlacklist.has(addr);
}

export async function checkLiquidity(
  provider: ethers.Provider,
  tokenIn:  string,
  tokenOut: string,
  amountIn: bigint,
  ethPriceUsd: bigint
): Promise<{ sufficient: boolean; liquidityUsd: number }> {
  try {
    const factory = new ethers.Contract(
      FACTORY_ADDRESS,
      ['function getPool(address,address,uint24) view returns (address)'],
      provider
    );

    for (const fee of [100, 500, 3000, 10000]) {
      try {
        const poolAddress = await factory.getPool(tokenIn, tokenOut, fee);
        if (poolAddress === ethers.ZeroAddress) continue;

        // Measure actual token balance in the pool — more reliable than raw liquidity()
        const tokenInContract = new ethers.Contract(tokenIn, TOKEN_ABI, provider);
        const [balanceRaw, decimals] = await Promise.all([
          tokenInContract.balanceOf(poolAddress),
          tokenInContract.decimals(),
        ]);

        let liquidityUsd: number;
        if (tokenIn.toLowerCase() === CONFIG.USDC.toLowerCase() ||
            tokenIn.toLowerCase() === CONFIG.USDT.toLowerCase()) {
          // Stablecoin: balance is already USD-denominated (6 decimals)
          liquidityUsd = Number(balanceRaw) / 10 ** Number(decimals);
        } else {
          // Non-stable (e.g. WETH): convert via on-chain price
          const tokenBalance = Number(balanceRaw) / 10 ** Number(decimals);
          liquidityUsd = tokenBalance * (Number(ethPriceUsd) / 1e6);
        }

        // Require pool to hold at least 2× the trade size
        const tradeUsd = Number(amountIn) / 1e6;
        if (liquidityUsd >= Math.max(CONFIG.MIN_LIQUIDITY_USD, tradeUsd * 2)) {
          return { sufficient: true, liquidityUsd };
        }
      } catch {
        continue;
      }
    }

    return { sufficient: false, liquidityUsd: 0 };
  } catch (error) {
    console.error('[FILTER] Liquidity check failed:', error);
    return { sufficient: false, liquidityUsd: 0 };
  }
}

export async function validateOpportunity(
  provider:    ethers.Provider,
  tokenIn:     string,
  tokenOut:    string,
  amountIn:    bigint,
  spreadBps:   number,
  ethPriceUsd: bigint
): Promise<{ valid: boolean; reason?: string; liquidityUsd?: number }> {

  if (spreadBps > CONFIG.MAX_SPREAD_BPS) {
    return { valid: false, reason: `Spread too wide: ${spreadBps} bps > ${CONFIG.MAX_SPREAD_BPS} bps` };
  }

  const [tokenInBlacklisted, tokenOutBlacklisted] = await Promise.all([
    isBlacklisted(tokenIn),
    isBlacklisted(tokenOut),
  ]);
  if (tokenInBlacklisted)  return { valid: false, reason: `Token ${tokenIn} is blacklisted`  };
  if (tokenOutBlacklisted) return { valid: false, reason: `Token ${tokenOut} is blacklisted` };

  const { sufficient, liquidityUsd } = await checkLiquidity(
    provider, tokenIn, tokenOut, amountIn, ethPriceUsd
  );
  if (!sufficient) {
    return { valid: false, reason: `Insufficient liquidity: $${liquidityUsd.toFixed(0)} < $${CONFIG.MIN_LIQUIDITY_USD}`, liquidityUsd };
  }

  return { valid: true, liquidityUsd };
}

export default { isBlacklisted, checkLiquidity, validateOpportunity };
