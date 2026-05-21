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
import { encodeTriangularPath, findTriangularOpportunities } from './core/triangularFinder';
import CONFIG, { usdcToUsd, weiToEth } from './config/constants';

const envFile = process.env.NODE_ENV === 'production' ? '.env.mainnet' : '.env.testnet';
dotenv.config({ path: envFile });

let circuitBreakerTriggered = false;
let initialBalance:          bigint | null = null;

let cachedEthPrice:    bigint | null = null;
let lastEthPriceUpdate = 0;

const pendingOpportunities = new Set<string>();

let debounceTimer:    NodeJS.Timeout | null = null;
let lastExecutionTime = 0;

// All pairs to scan on every cycle — more pairs = more opportunities
function getPairList(): Array<{ tokenIn: string; tokenOut: string; name: string }> {
  const { USDC, WETH, USDT, DAI } = CONFIG;
  const pairs = [
    { tokenIn: USDC,  tokenOut: WETH,  name: 'USDC/WETH'  },
    { tokenIn: USDT,  tokenOut: WETH,  name: 'USDT/WETH'  },
    { tokenIn: DAI,   tokenOut: WETH,  name: 'DAI/WETH'   },
    { tokenIn: USDC,  tokenOut: USDT,  name: 'USDC/USDT'  },
    { tokenIn: USDC,  tokenOut: DAI,   name: 'USDC/DAI'   },
    { tokenIn: USDT,  tokenOut: DAI,   name: 'USDT/DAI'   },
  ];
  // Add chain-specific tokens if available
  if ('cbBTC' in CONFIG && CONFIG.cbBTC) {
    pairs.push({ tokenIn: USDC, tokenOut: CONFIG.cbBTC as string, name: 'USDC/cbBTC' });
    pairs.push({ tokenIn: WETH, tokenOut: CONFIG.cbBTC as string, name: 'WETH/cbBTC' });
  }
  if ('cbETH' in CONFIG && CONFIG.cbETH) {
    pairs.push({ tokenIn: USDC, tokenOut: CONFIG.cbETH as string, name: 'USDC/cbETH' });
    pairs.push({ tokenIn: WETH, tokenOut: CONFIG.cbETH as string, name: 'WETH/cbETH' });
  }
  return pairs;
}

async function main() {
  console.log('Apex Predator MEV Bot Starting...');
  console.log(`Chain: ${CONFIG.CHAIN_ID} | Mode: ${process.env.DRY_RUN === 'true' ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Env: ${envFile}`);

  initSupabase();
  await initTelegram();

  const wsUrl = process.env.ALCHEMY_WSS_URL;
  if (!wsUrl) throw new Error('ALCHEMY_WSS_URL not set');

  const provider = await createWsProvider(wsUrl);
  console.log('[WSS] Connected');

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey || !/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw new Error('PRIVATE_KEY must be a 0x-prefixed 64-char hex string');
  }
  const wallet = new ethers.Wallet(privateKey, provider);
  console.log(`[WALLET] ${wallet.address}`);

  initialBalance = await provider.getBalance(wallet.address);
  console.log(`[WALLET] Balance: ${weiToEth(initialBalance).toFixed(4)} ETH`);
  if (initialBalance < ethers.parseEther('0.01')) {
    console.warn('[WALLET] Low balance (<0.01 ETH) — may fail on gas');
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

  const pairs = getPairList();
  console.log(`[PAIRS] Scanning ${pairs.length} pairs: ${pairs.map(p => p.name).join(', ')}`);
  console.log('\nBot LIVE — listening for opportunities\n');

  provider.on('pending', () => {
    if (circuitBreakerTriggered) return;

    const now           = Date.now();
    const sinceLastExec = now - lastExecutionTime;

    if (sinceLastExec >= CONFIG.MIN_EXEC_INTERVAL_MS) {
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      lastExecutionTime = now;
      scanAllOpportunities(provider, wallet, quoter, apexContract, pairs);
    } else if (!debounceTimer) {
      debounceTimer = setTimeout(() => {
        debounceTimer     = null;
        lastExecutionTime = Date.now();
        scanAllOpportunities(provider, wallet, quoter, apexContract, pairs);
      }, CONFIG.MIN_EXEC_INTERVAL_MS - sinceLastExec);
    }
  });

  setInterval(() => checkCircuitBreaker(provider, wallet.address), 30_000);

  process.on('SIGINT', async () => {
    console.log('\n[SHUTDOWN] Graceful shutdown');
    await provider.destroy();
    process.exit(0);
  });
}

async function scanAllOpportunities(
  provider:     ethers.Provider,
  wallet:       ethers.Wallet,
  quoter:       ethers.Contract,
  apexContract: ethers.Contract,
  pairs:        Array<{ tokenIn: string; tokenOut: string; name: string }>
) {
  if (pendingOpportunities.size >= CONFIG.MAX_CONCURRENT_CYCLES) return;

  const cycleId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  pendingOpportunities.add(cycleId);

  try {
    const [gasForecast, ethPrice] = await Promise.all([
      getGasForecast(provider),
      getEthPrice(provider, quoter),
    ]);
    if (!ethPrice) { pendingOpportunities.delete(cycleId); return; }

    // Scan all 2-leg pairs + triangular in parallel
    const [pairResults, triangularResults] = await Promise.all([
      Promise.allSettled(pairs.map(pair =>
        scanPair(provider, wallet, quoter, apexContract, pair, gasForecast, ethPrice)
      )),
      findTriangularOpportunities(provider, CONFIG.UNI_QUOTER_V2, CONFIG.MIN_LOAN_USDC, gasForecast, ethPrice),
    ]);

    // Execute best triangular opportunity if found
    if (triangularResults.length > 0) {
      const best = triangularResults[0];
      console.log(`[TRIANGULAR] Best: score=${best.profitResult.score} bps, profit=$${usdcToUsd(best.expectedProfit).toFixed(2)}`);
      if (process.env.DRY_RUN !== 'true') {
        await executeArbitrage(provider, wallet, apexContract, {
          tokenIn:      best.tokens[0],
          tokenOut:     best.tokens[1],
          amountIn:     CONFIG.MIN_LOAN_USDC,
          buyRouter:    CONFIG.UNI_ROUTER,
          sellRouter:   CONFIG.UNI_ROUTER,
          path:         best.encodedPath,
          profitResult: best.profitResult,
          buyOnDex:     'uniswap',
          sellOnDex:    'uniswap',
          wethBought:   best.quotes[0],
          usdcReceived: best.quotes[2],
        });
      } else {
        console.log(`[DRY_RUN] Triangular: $${usdcToUsd(best.expectedProfit).toFixed(2)}`);
        alertProfit(best.expectedProfit);
      }
    }

    // Log settled pair results
    let executed = 0;
    for (const result of pairResults) {
      if (result.status === 'fulfilled' && result.value) executed++;
    }
    if (executed > 0) console.log(`[CYCLE] Executed ${executed} trades`);

  } catch (error: any) {
    console.error('[SCAN]', error.message);
  } finally {
    pendingOpportunities.delete(cycleId);
  }
}

interface TradeParams {
  tokenIn:      string;
  tokenOut:     string;
  amountIn:     bigint;
  buyRouter:    string;
  sellRouter:   string;
  path:         string;
  profitResult: ReturnType<typeof calculateNetProfit>;
  buyOnDex:     string;
  sellOnDex:    string;
  wethBought:   bigint;
  usdcReceived: bigint;
}

async function scanPair(
  provider:     ethers.Provider,
  wallet:       ethers.Wallet,
  quoter:       ethers.Contract,
  apexContract: ethers.Contract,
  pair:         { tokenIn: string; tokenOut: string; name: string },
  gasForecast:  Awaited<ReturnType<typeof getGasForecast>>,
  ethPrice:     bigint
): Promise<boolean> {
  try {
    const amountIn = CONFIG.MIN_LOAN_USDC;

    const [rawFee3000, rawFee500] = await Promise.all([
      quoter.quoteExactInputSingle.staticCall({
        tokenIn: pair.tokenIn, tokenOut: pair.tokenOut,
        amountIn, fee: 3000, sqrtPriceLimitX96: 0,
      }).catch(() => null),
      quoter.quoteExactInputSingle.staticCall({
        tokenIn: pair.tokenIn, tokenOut: pair.tokenOut,
        amountIn, fee: 500, sqrtPriceLimitX96: 0,
      }).catch(() => null),
    ]);

    if (!rawFee3000 && !rawFee500) return false;

    const out3000: bigint = rawFee3000?.[0] ?? 0n;
    const out500:  bigint = rawFee500?.[0]  ?? 0n;

    const [buyOnDex, sellOnDex, buyRouter, sellRouter, tokenOutBought, buyFee, sellFee] =
      out3000 >= out500
        ? ['uni-3000', 'uni-500',  CONFIG.UNI_ROUTER, CONFIG.SUSHI_ROUTER, out3000, 3000, 500]
        : ['uni-500',  'uni-3000', CONFIG.SUSHI_ROUTER, CONFIG.UNI_ROUTER, out500,  500,  3000];

    if ((tokenOutBought as bigint) === 0n) return false;

    const sellRaw = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: pair.tokenOut, tokenOut: pair.tokenIn,
      amountIn: tokenOutBought, fee: sellFee as number, sqrtPriceLimitX96: 0,
    }).catch(() => null);
    if (!sellRaw) return false;

    const tokenInReceived: bigint = sellRaw[0];
    const spreadBps = amountIn > 0n
      ? Number(((tokenInReceived - amountIn) * 10_000n) / amountIn)
      : 0;

    const validation = await validateOpportunity(
      provider, pair.tokenIn, pair.tokenOut, amountIn, spreadBps, ethPrice
    );
    if (!validation.valid) {
      if (CONFIG.LOG_LEVEL === 'debug') console.log(`[FILTER] ${pair.name}: ${validation.reason}`);
      return false;
    }

    const profitResult = calculateNetProfit(amountIn, tokenOutBought as bigint, tokenInReceived, gasForecast, ethPrice);

    logOpportunity({
      block_number:          await provider.getBlockNumber(),
      token_in:              pair.tokenIn.toLowerCase(),
      token_out:             pair.tokenOut.toLowerCase(),
      dex_buy:               buyOnDex as string,
      dex_sell:              sellOnDex as string,
      amount_in_usdc:        amountIn.toString(),
      expected_profit_usdc:  profitResult.netProfit.toString(),
      score_bps:             profitResult.score,
      quotes_json:           { tokenOutBought: (tokenOutBought as bigint).toString(), tokenInReceived: tokenInReceived.toString() },
      slippage_estimate_bps: profitResult.slippageEstimateBps,
      gas_cost_wei:          profitResult.gasCostWei.toString(),
      status:                'detected',
      liquidity_usd:         validation.liquidityUsd,
    });

    if (!profitResult.shouldExecute) {
      if (CONFIG.LOG_LEVEL === 'debug') {
        console.log(`[PROFIT] ${pair.name}: ${profitResult.score} bps (need ${CONFIG.MIN_PROFIT_BPS})`);
      }
      return false;
    }

    console.log(`[OPPORTUNITY] ${pair.name}: ${profitResult.score} bps, $${usdcToUsd(profitResult.netProfit).toFixed(2)}`);

    if (process.env.DRY_RUN === 'true') {
      console.log(`[DRY_RUN] Would execute ${pair.name}`);
      alertProfit(profitResult.netProfit);
      return true;
    }

    const path = encodeTriangularPath(
      [pair.tokenIn, pair.tokenOut, pair.tokenIn] as [string, string, string],
      [buyFee as number, sellFee as number, buyFee as number]
    );

    return executeArbitrage(provider, wallet, apexContract, {
      tokenIn: pair.tokenIn, tokenOut: pair.tokenOut,
      amountIn, buyRouter: buyRouter as string, sellRouter: sellRouter as string,
      path, profitResult, buyOnDex: buyOnDex as string, sellOnDex: sellOnDex as string,
      wethBought: tokenOutBought as bigint, usdcReceived: tokenInReceived,
    });

  } catch (error: any) {
    if (CONFIG.LOG_LEVEL === 'debug') console.error(`[SCAN] ${pair.name}:`, error.message);
    return false;
  }
}

async function executeArbitrage(
  provider:     ethers.Provider,
  wallet:       ethers.Wallet,
  apexContract: ethers.Contract,
  params:       TradeParams
): Promise<boolean> {
  try {
    const tx = await apexContract.executeArbitrage.populateTransaction(
      params.tokenIn, params.amountIn, params.buyRouter, params.sellRouter, params.path
    );

    tx.from                = wallet.address;
    tx.chainId             = BigInt(CONFIG.CHAIN_ID);
    tx.gasLimit            = CONFIG.GAS_ESTIMATE;
    tx.maxFeePerGas        = params.profitResult.maxFeePerGas;
    tx.maxPriorityFeePerGas = params.profitResult.priorityFeePerGas;
    tx.nonce               = await provider.getTransactionCount(wallet.address);

    const signedTx    = await wallet.signTransaction(tx);
    const targetBlock = (await provider.getBlockNumber()) + 1;
    const result      = await submitBundleWithFailover(signedTx, targetBlock, wallet, provider);

    if (result.success) {
      console.log(`[SUCCESS] via ${result.builder}, profit: $${usdcToUsd(params.profitResult.netProfit).toFixed(2)}`);
      alertProfit(params.profitResult.netProfit, result.txHash);
      logTrade({
        block_number:       targetBlock,
        tx_hash:            result.txHash ?? 'unknown',
        builder_used:       result.builder,
        token_in:           params.tokenIn.toLowerCase(),
        token_out:          params.tokenOut.toLowerCase(),
        amount_in_usdc:     params.amountIn.toString(),
        actual_profit_usdc: params.profitResult.netProfit.toString(),
        gas_cost_wei:       params.profitResult.gasCostWei.toString(),
        gas_price_gwei:     Number(params.profitResult.maxFeePerGas / 1_000_000_000n),
        execution_time_ms:  0,
        status:             'included',
      });
      return true;
    }

    console.log(`[FAILED] ${result.error}`);
    return false;
  } catch (error: any) {
    console.error('[EXECUTE]', error.message);
    return false;
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
