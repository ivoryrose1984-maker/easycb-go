// src/ApexPredator.ts
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import { createWsProvider } from './infrastructure/wsProvider';
import { initSupabase, logOpportunity, logTrade } from './infrastructure/supabaseLogger';
import { getGasForecast } from './infrastructure/gasForecaster';
import { initTelegram, alertProfit, alertCircuitBreaker, alertError } from './infrastructure/telegramAlert';
import { calculateNetProfit } from './core/bidMath';
import { validateOpportunity } from './core/filters';
import { submitBundleWithFailover } from './core/bundleSubmitter';
import { encodeTriangularPath } from './core/triangularFinder';
import CONFIG, { usdcToUsd, weiToEth } from './config/constants';

// Load env based on NODE_ENV so testnet and mainnet configs are separate
const envFile = process.env.NODE_ENV === 'production' ? '.env.mainnet' : '.env.testnet';
dotenv.config({ path: envFile });

let circuitBreakerTriggered = false;
let initialBalance:         bigint | null = null;

let cachedEthPrice:   bigint | null = null;
let lastEthPriceUpdate = 0;

const pendingOpportunities = new Set<string>();

// Debounce with hard minimum interval so frequent pending-tx events don't stall execution
let debounceTimer:    NodeJS.Timeout | null = null;
let lastExecutionTime = 0;

async function main() {
  console.log('🚀 Apex Predator MEV Bot — Starting...');
  console.log(`Mode: ${process.env.DRY_RUN === 'true' ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Env:  ${envFile}`);

  initSupabase();
  await initTelegram();

  const wsUrl = process.env.ALCHEMY_WSS_URL;
  if (!wsUrl) throw new Error('ALCHEMY_WSS_URL not set');

  console.log('[WSS] Connecting to Alchemy...');
  const provider = await createWsProvider(wsUrl);
  console.log('[WSS] ✅ Connected');

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey || !/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw new Error('PRIVATE_KEY must be a 0x-prefixed 64-char hex string');
  }
  const wallet = new ethers.Wallet(privateKey, provider);
  console.log(`[WALLET] ${wallet.address}`);

  initialBalance = await provider.getBalance(wallet.address);
  console.log(`[WALLET] Balance: ${weiToEth(initialBalance).toFixed(4)} ETH`);
  if (initialBalance < ethers.parseEther('0.01')) {
    console.warn('⚠️  Low balance (<0.01 ETH) — may fail on gas');
  }

  const apexContract = new ethers.Contract(
    CONFIG.APEX_FLASH_LOAN,
    ['function executeArbitrage(address tokenBorrow, uint256 amount, address dexBuy, address dexSell, bytes calldata path) external'],
    wallet
  );

  const quoter = new ethers.Contract(
    CONFIG.UNI_QUOTER_V2,
    ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160,uint32,uint256)'],
    provider
  );

  console.log('[CONTRACTS] Loaded');
  console.log('\n🎯 Bot LIVE — listening for opportunities…\n');

  provider.on('pending', () => {
    if (circuitBreakerTriggered) return;

    const now            = Date.now();
    const sinceLastExec  = now - lastExecutionTime;

    if (sinceLastExec >= CONFIG.MIN_EXEC_INTERVAL_MS) {
      // Enough time has elapsed — run immediately
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      lastExecutionTime = now;
      findAndExecuteOpportunity(provider, wallet, quoter, apexContract);
    } else if (!debounceTimer) {
      // Schedule for when the interval expires
      debounceTimer = setTimeout(() => {
        debounceTimer     = null;
        lastExecutionTime = Date.now();
        findAndExecuteOpportunity(provider, wallet, quoter, apexContract);
      }, CONFIG.MIN_EXEC_INTERVAL_MS - sinceLastExec);
    }
    // If timer is already set, leave it — avoids resetting on every pending tx
  });

  setInterval(() => checkCircuitBreaker(provider, wallet.address), 30_000);

  process.on('SIGINT', async () => {
    console.log('\n[SHUTDOWN] Graceful shutdown…');
    await provider.destroy();
    process.exit(0);
  });
}

async function findAndExecuteOpportunity(
  provider:      ethers.Provider,
  wallet:        ethers.Wallet,
  quoter:        ethers.Contract,
  apexContract:  ethers.Contract
) {
  const opportunityId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    if (pendingOpportunities.size >= CONFIG.MAX_CONCURRENT_CYCLES) return;
    pendingOpportunities.add(opportunityId);

    const [gasForecast, ethPrice] = await Promise.all([
      getGasForecast(provider),
      getEthPrice(provider, quoter),
    ]);

    if (!ethPrice) { pendingOpportunities.delete(opportunityId); return; }

    const amountIn = CONFIG.MIN_LOAN_USDC;

    // Get both DEX quotes in parallel
    // On testnet we use a different Uniswap fee tier (500 vs 3000) as a proxy for SushiSwap
    const [uniRaw, sushiRaw] = await Promise.all([
      quoter.quoteExactInputSingle.staticCall({
        tokenIn: CONFIG.USDC, tokenOut: CONFIG.WETH,
        amountIn, fee: 3000, sqrtPriceLimitX96: 0,
      }),
      quoter.quoteExactInputSingle.staticCall({
        tokenIn: CONFIG.USDC, tokenOut: CONFIG.WETH,
        amountIn, fee: 500, sqrtPriceLimitX96: 0,
      }),
    ]);

    const wethFromUni:   bigint = uniRaw[0];
    const wethFromSushi: bigint = sushiRaw[0];

    // Identify buy-low / sell-high direction
    const [buyOnDex, sellOnDex, buyRouter, sellRouter, wethBought] =
      wethFromUni >= wethFromSushi
        ? ['uniswap',   'sushiswap', CONFIG.UNI_ROUTER,   CONFIG.SUSHI_ROUTER, wethFromUni]
        : ['sushiswap', 'uniswap',   CONFIG.SUSHI_ROUTER, CONFIG.UNI_ROUTER,   wethFromSushi];

    // Get sell quote for the larger WETH amount
    const sellRaw = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: CONFIG.WETH, tokenOut: CONFIG.USDC,
      amountIn: wethBought,
      fee: buyOnDex === 'uniswap' ? 500 : 3000,
      sqrtPriceLimitX96: 0,
    });
    const usdcReceived: bigint = sellRaw[0];

    const spreadBps = amountIn > 0n
      ? Number(((usdcReceived - amountIn) * 10_000n) / amountIn)
      : 0;

    const validation = await validateOpportunity(
      provider, CONFIG.USDC, CONFIG.WETH, amountIn, spreadBps, ethPrice
    );

    if (!validation.valid) {
      if (CONFIG.LOG_LEVEL === 'debug') console.log(`[FILTER] ${validation.reason}`);
      pendingOpportunities.delete(opportunityId);
      return;
    }

    const profitResult = calculateNetProfit(amountIn, wethBought, usdcReceived, gasForecast, ethPrice);

    logOpportunity({
      block_number:         await provider.getBlockNumber(),
      token_in:             CONFIG.USDC.toLowerCase(),
      token_out:            CONFIG.WETH.toLowerCase(),
      dex_buy:              buyOnDex,
      dex_sell:             sellOnDex,
      amount_in_usdc:       amountIn.toString(),
      expected_profit_usdc: profitResult.netProfit.toString(),
      score_bps:            profitResult.score,
      quotes_json:          { wethBought: wethBought.toString(), usdcReceived: usdcReceived.toString() },
      slippage_estimate_bps:profitResult.slippageEstimateBps,
      gas_cost_wei:         profitResult.gasCostWei.toString(),
      status:               'detected',
      liquidity_usd:        validation.liquidityUsd,
    });

    if (!profitResult.shouldExecute) {
      if (CONFIG.LOG_LEVEL === 'debug') {
        console.log(`[PROFIT] Too low: ${profitResult.score} bps (need ${CONFIG.MIN_PROFIT_BPS})`);
      }
      pendingOpportunities.delete(opportunityId);
      return;
    }

    console.log(`[OPPORTUNITY] Score: ${profitResult.score} bps, Profit: $${usdcToUsd(profitResult.netProfit).toFixed(2)}`);

    if (process.env.DRY_RUN === 'true') {
      console.log('[DRY_RUN] Would execute trade here');
      alertProfit(profitResult.netProfit);
      pendingOpportunities.delete(opportunityId);
      return;
    }

    // Build properly encoded path: USDC → WETH (single hop)
    const path = encodeTriangularPath(
      [CONFIG.USDC, CONFIG.WETH, CONFIG.USDC],
      [3000, 3000, 3000]
    );

    const tx = await apexContract.executeArbitrage.populateTransaction(
      CONFIG.USDC, amountIn, buyRouter, sellRouter, path
    );

    tx.from               = wallet.address;
    tx.chainId            = BigInt(CONFIG.CHAIN_ID);
    tx.gasLimit           = CONFIG.GAS_ESTIMATE;
    tx.maxFeePerGas       = profitResult.maxFeePerGas;
    tx.maxPriorityFeePerGas = profitResult.priorityFeePerGas; // per-gas value
    tx.nonce              = await provider.getTransactionCount(wallet.address);

    const signedTx    = await wallet.signTransaction(tx);
    const targetBlock = (await provider.getBlockNumber()) + 1;

    const result = await submitBundleWithFailover(signedTx, targetBlock, wallet, provider);

    if (result.success) {
      console.log(`[SUCCESS] Executed via ${result.builder}`);
      alertProfit(profitResult.netProfit, result.txHash);
      logTrade({
        block_number:       targetBlock,
        tx_hash:            result.txHash ?? 'unknown',
        builder_used:       result.builder,
        token_in:           CONFIG.USDC.toLowerCase(),
        token_out:          CONFIG.WETH.toLowerCase(),
        amount_in_usdc:     amountIn.toString(),
        actual_profit_usdc: profitResult.netProfit.toString(),
        gas_cost_wei:       profitResult.gasCostWei.toString(),
        gas_price_gwei:     Number(profitResult.maxFeePerGas / 1_000_000_000n),
        execution_time_ms:  0,
        status:             'included',
      });
    } else {
      console.log(`[FAILED] ${result.error}`);
    }

    pendingOpportunities.delete(opportunityId);

  } catch (error: any) {
    console.error('[ERROR]', error.message);
    pendingOpportunities.delete(opportunityId); // use captured id, not Date.now()
  }
}

async function getEthPrice(provider: ethers.Provider, quoter: ethers.Contract): Promise<bigint | null> {
  const now = Date.now();
  if (cachedEthPrice && now - lastEthPriceUpdate < CONFIG.ETH_PRICE_CACHE_MS) return cachedEthPrice;

  try {
    const result = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: CONFIG.WETH, tokenOut: CONFIG.USDC,
      amountIn: ethers.parseEther('1'), fee: 3000, sqrtPriceLimitX96: 0,
    });
    cachedEthPrice     = result[0];
    lastEthPriceUpdate = now;
    return cachedEthPrice;
  } catch (error) {
    console.error('[ORACLE] ETH price fetch failed:', error);
    return null;
  }
}

async function checkCircuitBreaker(provider: ethers.Provider, address: string) {
  if (circuitBreakerTriggered || !initialBalance) return;

  try {
    const currentBalance = await provider.getBalance(address);
    if (currentBalance >= initialBalance) return;

    const drawdownPct = Number((initialBalance - currentBalance) * 10_000n / initialBalance) / 100;
    if (drawdownPct >= CONFIG.DRAWDOWN_THRESHOLD) {
      circuitBreakerTriggered = true;
      const msg = `Circuit breaker: ${drawdownPct.toFixed(1)}% drawdown`;
      console.error(`[CIRCUIT BREAKER] ${msg}`);
      alertCircuitBreaker(msg);
      process.exit(1);
    }
  } catch (error: any) {
    console.error('[CIRCUIT BREAKER] Check failed:', error.message);
  }
}

main().catch(error => {
  console.error('[FATAL]', error);
  alertError(error.message);
  process.exit(1);
});
