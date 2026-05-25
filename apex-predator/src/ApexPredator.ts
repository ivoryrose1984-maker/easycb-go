// src/ApexPredator.ts
import * as dotenv from 'dotenv';
import { ethers } from 'ethers';
import { createWsProvider } from './infrastructure/wsProvider';
import { initSupabase, logOpportunity, logTrade, logRejection, REJECTION } from './infrastructure/supabaseLogger';
import { getGasForecast } from './infrastructure/gasForecaster';
import { initTelegram, alertProfit, alertCircuitBreaker, alertError, sendAlert } from './infrastructure/telegramAlert';
import { calculateNetProfit, findOptimalLoanSize } from './core/bidMath';
import { validateOpportunity } from './core/filters';
import { submitBundleWithFailover } from './core/bundleSubmitter';
import { encode2HopPath, findTriangularOpportunities, TriangularPath } from './core/triangularFinder';
import CONFIG, { usdcToUsd, weiToEth } from './config/constants';

dotenv.config({ path: process.env.NODE_ENV === 'production' ? '.env.mainnet' : '.env.testnet' });

// Safe default: live execution requires DRY_RUN=false explicitly.
// Absent, undefined, or any other value keeps the bot in dry-run mode.
const DRY_RUN = process.env.DRY_RUN !== 'false';

let circuitBreakerTriggered = false;
let initialBalance:          bigint | null = null;

let cachedEthPrice:    bigint | null = null;
let lastEthPriceUpdate = 0;

const pendingOpportunities = new Set<string>();

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
  console.log(`Chain: ${CONFIG.CHAIN_ID} | Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Env: ${process.env.NODE_ENV === 'production' ? '.env.mainnet' : '.env.testnet'}`);

  if (!process.env.APEX_FLASH_LOAN_BASE) {
    console.error('FATAL: APEX_FLASH_LOAN_BASE not set');
    process.exit(1);
  }

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
    ['function executeArbitrage(address flashToken, uint256 flashAmount, address uniV3Router, bytes calldata path, uint256 minAmountOut) external'],
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

  provider.on('block', () => {
    if (circuitBreakerTriggered) {
      logRejection({ timestamp: new Date().toISOString(), pair: 'all', loan_amount: '0', reason_code: REJECTION.CIRCUIT_BREAKER_OPEN, net_profit_wei: '0' });
      return;
    }
    scanAllOpportunities(provider, wallet, quoter, apexContract, pairs);
  });

  setInterval(() => checkCircuitBreaker(provider, wallet.address), 30_000);
  setInterval(() => checkGasBalance(provider, wallet.address), 300_000); // every 5 min

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
    let bestTriOpps: TriangularPath[] = [];

    const [pairResults, triangularResults] = await Promise.all([
      Promise.allSettled(pairs.map(pair =>
        scanPair(provider, wallet, quoter, apexContract, pair, gasForecast, ethPrice)
      )),
      findOptimalLoanSize(async (size) => {
        const opps = await findTriangularOpportunities(provider, CONFIG.UNI_QUOTER_V2, size, gasForecast, ethPrice);
        if (opps.length > 0) {
          bestTriOpps = opps;
          return opps[0].profitResult;
        }
        return calculateNetProfit(size, 0n, 0n, gasForecast, ethPrice);
      }),
    ]);

    // Execute best triangular opportunity if found
    if (bestTriOpps.length > 0) {
      const best = bestTriOpps[0];
      console.log(`[TRIANGULAR] Best: score=${best.profitResult.score} bps, profit=$${usdcToUsd(best.expectedProfit).toFixed(2)}, loan=$${usdcToUsd(triangularResults.optimalAmount).toFixed(0)}`);
      if (!DRY_RUN) {
        await executeArbitrage(provider, wallet, apexContract, {
          tokenIn:      best.tokens[0],
          tokenOut:     best.tokens[1],
          amountIn:     triangularResults.optimalAmount,
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
    // Quick probe at minimum size across ALL fee tiers to find best buy/sell combination
    const probe = CONFIG.MIN_LOAN_USDC;
    const FEE_TIERS = [100, 500, 3000, 10000];

    const buyQuotes = await Promise.all(FEE_TIERS.map(fee =>
      quoter.quoteExactInputSingle.staticCall({
        tokenIn: pair.tokenIn, tokenOut: pair.tokenOut,
        amountIn: probe, fee, sqrtPriceLimitX96: 0,
      }).catch(() => null)
    ));

    // Best buy = most tokenOut per USDC in
    let buyFee = FEE_TIERS[0], bestBuyOut = 0n;
    for (let i = 0; i < FEE_TIERS.length; i++) {
      const out: bigint = buyQuotes[i]?.[0] ?? 0n;
      if (out > bestBuyOut) { bestBuyOut = out; buyFee = FEE_TIERS[i]; }
    }
    if (bestBuyOut === 0n) {
      logRejection({ timestamp: new Date().toISOString(), pair: pair.name, loan_amount: '0', reason_code: REJECTION.NO_BUY_QUOTE, net_profit_wei: '0' });
      return false;
    }

    // Best sell = most tokenIn back (from a DIFFERENT fee tier — that's where the arb lives)
    const sellQuotes = await Promise.all(FEE_TIERS.filter(f => f !== buyFee).map(fee =>
      quoter.quoteExactInputSingle.staticCall({
        tokenIn: pair.tokenOut, tokenOut: pair.tokenIn,
        amountIn: bestBuyOut, fee, sqrtPriceLimitX96: 0,
      }).catch(() => null)
    ));
    const sellFeeTiers = FEE_TIERS.filter(f => f !== buyFee);

    let sellFee = sellFeeTiers[0], bestSellOut = 0n;
    for (let i = 0; i < sellFeeTiers.length; i++) {
      const out: bigint = sellQuotes[i]?.[0] ?? 0n;
      if (out > bestSellOut) { bestSellOut = out; sellFee = sellFeeTiers[i]; }
    }
    if (bestSellOut === 0n) {
      logRejection({ timestamp: new Date().toISOString(), pair: pair.name, loan_amount: '0', reason_code: REJECTION.NO_SELL_QUOTE, net_profit_wei: '0' });
      return false;
    }

    const [buyOnDex, sellOnDex, buyRouter, sellRouter] = [
      `uni-${buyFee}`, `uni-${sellFee}`, CONFIG.UNI_ROUTER, CONFIG.UNI_ROUTER,
    ];

    const probeReceived = bestSellOut;
    const spreadBps = probe > 0n
      ? Number(((probeReceived - probe) * 10_000n) / probe)
      : 0;

    if (spreadBps < CONFIG.MIN_PROFIT_BPS) {
      logRejection({ timestamp: new Date().toISOString(), pair: pair.name, loan_amount: probe.toString(), reason_code: REJECTION.SPREAD_TOO_THIN, net_profit_wei: '0' });
      return false;
    }

    const validation = await validateOpportunity(
      provider, pair.tokenIn, pair.tokenOut, probe, spreadBps, ethPrice
    );
    if (!validation.valid) {
      if (CONFIG.LOG_LEVEL === 'debug') console.log(`[FILTER] ${pair.name}: ${validation.reason}`);
      const rc = validation.reason?.toLowerCase().includes('blacklist') ? REJECTION.BLACKLISTED : REJECTION.INSUFFICIENT_LIQUIDITY;
      logRejection({ timestamp: new Date().toISOString(), pair: pair.name, loan_amount: probe.toString(), reason_code: rc, net_profit_wei: '0' });
      return false;
    }

    // ── Atlas loan floor ──────────────────────────────────────────────────────
    // minimum_loan = (target_profit_usd + gas_cost_usd) / ((edge_bps - variable_cost_bps) / 10000)
    // If the floor exceeds MAX_LOAN_USDC, this spread can't yield target profit at any loan size.
    {
      const gasCostUsdc = (CONFIG.GAS_ESTIMATE *
        (gasForecast.predictedBaseFee + CONFIG.MIN_PRIORITY_FEE_GWEI * 1_000_000_000n) *
        ethPrice) / (10n ** 18n);
      const TARGET_PROFIT_USDC = 5_000_000n;                         // $5 floor
      const variableCostBps    = BigInt(CONFIG.FLASH_LOAN_FEE_BPS) + 10n; // fee + ~10bps slippage
      const edgeMinusCosts     = BigInt(spreadBps) - variableCostBps;
      if (edgeMinusCosts > 0n) {
        const loanFloor = ((TARGET_PROFIT_USDC + gasCostUsdc) * 10_000n) / edgeMinusCosts;
        if (loanFloor > CONFIG.MAX_LOAN_USDC) {
          logRejection({ timestamp: new Date().toISOString(), pair: pair.name, loan_amount: CONFIG.MAX_LOAN_USDC.toString(), reason_code: REJECTION.LOAN_FLOOR_EXCEEDED, net_profit_wei: '0' });
          return false;
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Spread confirmed — find optimal loan size via ternary search (8 iterations, $1K–$100K)
    const { optimalAmount: amountIn, maxProfit: profitResult } = await findOptimalLoanSize(
      async (size) => {
        const bRaw = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: pair.tokenIn, tokenOut: pair.tokenOut,
          amountIn: size, fee: buyFee, sqrtPriceLimitX96: 0,
        }).catch(() => null);
        if (!bRaw) return calculateNetProfit(size, 0n, 0n, gasForecast, ethPrice);
        const midOut: bigint = bRaw[0];
        const sRaw = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: pair.tokenOut, tokenOut: pair.tokenIn,
          amountIn: midOut, fee: sellFee, sqrtPriceLimitX96: 0,
        }).catch(() => null);
        return calculateNetProfit(size, midOut, sRaw?.[0] ?? 0n, gasForecast, ethPrice);
      }
    );

    // Re-fetch final quotes at optimal size for execution
    const finalBuyRaw = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: pair.tokenIn, tokenOut: pair.tokenOut,
      amountIn, fee: buyFee, sqrtPriceLimitX96: 0,
    }).catch(() => null);
    if (!finalBuyRaw) {
      logRejection({ timestamp: new Date().toISOString(), pair: pair.name, loan_amount: amountIn.toString(), reason_code: REJECTION.STALE_FINAL_QUOTE, net_profit_wei: '0' });
      return false;
    }
    const tokenOutBought: bigint = finalBuyRaw[0];

    const finalSellRaw = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: pair.tokenOut, tokenOut: pair.tokenIn,
      amountIn: tokenOutBought, fee: sellFee, sqrtPriceLimitX96: 0,
    }).catch(() => null);
    if (!finalSellRaw) {
      logRejection({ timestamp: new Date().toISOString(), pair: pair.name, loan_amount: amountIn.toString(), reason_code: REJECTION.STALE_FINAL_QUOTE, net_profit_wei: '0' });
      return false;
    }
    const tokenInReceived: bigint = finalSellRaw[0];

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
      logRejection({ timestamp: new Date().toISOString(), pair: pair.name, loan_amount: amountIn.toString(), reason_code: REJECTION.BELOW_PROFIT_THRESHOLD, net_profit_wei: profitResult.netProfit.toString() });
      return false;
    }

    console.log(`[OPPORTUNITY] ${pair.name}: ${profitResult.score} bps, $${usdcToUsd(profitResult.netProfit).toFixed(2)}`);

    if (DRY_RUN) {
      console.log(`[DRY_RUN] Would execute ${pair.name}`);
      alertProfit(profitResult.netProfit);
      return true;
    }

    const path = encode2HopPath(
      pair.tokenIn, buyFee as number, pair.tokenOut, sellFee as number, pair.tokenIn
    );

    return executeArbitrage(provider, wallet, apexContract, {
      tokenIn: pair.tokenIn, tokenOut: pair.tokenOut,
      amountIn, buyRouter: buyRouter as string, sellRouter: sellRouter as string,
      path, profitResult, buyOnDex: buyOnDex as string, sellOnDex: sellOnDex as string,
      wethBought: tokenOutBought as bigint, usdcReceived: tokenInReceived,
    });

  } catch (error: any) {
    if (CONFIG.LOG_LEVEL === 'debug') console.error(`[SCAN] ${pair.name}:`, error.message);
    logRejection({ timestamp: new Date().toISOString(), pair: pair.name, loan_amount: '0', reason_code: REJECTION.EXCEPTION, net_profit_wei: '0' });
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
    // minAmountOut: require at least MIN_PROFIT_BPS above the loan back (sandwich guard)
    const minAmountOut = (params.amountIn * BigInt(10000 + CONFIG.MIN_PROFIT_BPS)) / 10000n;
    const tx = await apexContract.executeArbitrage.populateTransaction(
      params.tokenIn, params.amountIn, CONFIG.UNI_ROUTER, params.path, minAmountOut
    );

    tx.from                = wallet.address;
    tx.chainId             = BigInt(CONFIG.CHAIN_ID);
    tx.gasLimit            = CONFIG.TX_GAS_LIMIT;
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

// Gas thresholds in ETH
const GAS_WARN_ETH    = ethers.parseEther('0.05'); // alert at 0.05 ETH remaining
const GAS_CRITICAL_ETH = ethers.parseEther('0.02'); // critical at 0.02 ETH

let lastGasAlertTime = 0;
const GAS_ALERT_COOLDOWN_MS = 3_600_000; // max one alert per hour

async function checkGasBalance(provider: ethers.Provider, address: string) {
  try {
    const balance = await provider.getBalance(address);
    const now     = Date.now();

    if (balance < GAS_CRITICAL_ETH) {
      if (now - lastGasAlertTime > GAS_ALERT_COOLDOWN_MS) {
        lastGasAlertTime = now;
        const ethBal = weiToEth(balance).toFixed(4);
        const msg    = `⛽ CRITICAL: Gas wallet at ${ethBal} ETH — bot will stall soon. Send at least 0.05 ETH to ${address}`;
        console.error(`[GAS] ${msg}`);
        sendAlert(msg, 'critical');
      }
    } else if (balance < GAS_WARN_ETH) {
      if (now - lastGasAlertTime > GAS_ALERT_COOLDOWN_MS) {
        lastGasAlertTime = now;
        const ethBal = weiToEth(balance).toFixed(4);
        const msg    = `⛽ Low gas: ${ethBal} ETH remaining. Top up to keep bots running. Send ETH to ${address}`;
        console.warn(`[GAS] ${msg}`);
        sendAlert(msg, 'alert');
      }
    }
  } catch (error: any) {
    console.error('[GAS] Balance check failed:', error.message);
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
