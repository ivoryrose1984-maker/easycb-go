import CONFIG                     from '../core/config';
import { requireLiveAllowed }      from '../core/safety';
import { getRunContext, uptime }   from '../core/runContext';
import { logger }                  from '../core/logger';
import { logSummary, logError }    from '../core/jsonlLogger';
import { initTelegram, sendAlert, alertError } from '../infrastructure/telegramAlert';
import { rpcHealth }                           from '../core/rpcHealth';
import { ResilientWsProvider }     from '../infrastructure/ResilientWsProvider';
import { getCexFeed }              from '../signals/cexContextSignal';
import { CbEthFairValueScanner }   from '../scanners/cbETHFairValueScanner';
import { ApexPairScanner }         from '../scanners/apexPairScanner';
import { ApexTriangularScanner }   from '../scanners/apexTriangularScanner';
import { AerodromeScanner }        from '../scanners/aerodromeScanner';
import { checkCircuitBreaker, setInitialBalance } from '../risk/circuitBreaker';
import { acquireLock }             from '../risk/networkMutex';
import { FastPathExecutor }        from '../execution/FastPathExecutor';
import { setupExecutor, updateExecutorEthPrice } from '../execution/dryRunExecutor';
import { getHttpProvider }         from '../infrastructure/fallbackProvider';
import { runStartupValidation }    from '../core/startupValidator';
import { ethers }                  from 'ethers';

const APEX_ABI = [
  'function executeArbitrage(address flashToken, uint256 flashAmount, address uniV3Router, bytes calldata path, uint256 minAmountOut) external',
];

// ── Safety — this must be the FIRST thing that runs ──────────────────────────
requireLiveAllowed();   // throws if DRY_RUN=true / ALLOW_LIVE!=true / WALLET_PRIVATE_KEY missing / contract not deployed

if (parseInt(process.env.CHAIN_ID ?? '8453', 10) !== 8453) {
  throw new Error(`CHAIN_ID must be 8453 (Base), got ${process.env.CHAIN_ID}`);
}

process.on('unhandledRejection', (reason) => {
  const errCode = (reason as any)?.error?.code;
  const msg     = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  const isRateLimit = errCode === 15
    || msg.toLowerCase().includes('too many request')
    || msg.toLowerCase().includes('rate limit');

  if (isRateLimit) {
    rpcHealth.mark429();
    logger.warn('RPC', 'Rate-limit on eth_subscribe (code 15) — RWS will back off and reconnect');
    return;
  }

  logger.error('FATAL', `unhandledRejection: ${msg}`);
  logError({ timestamp: new Date().toISOString(), block: 0, error: `unhandledRejection: ${msg}` });
});

process.on('uncaughtException', (err) => {
  logger.error('FATAL', `uncaughtException: ${err.stack ?? err.message}`);
  logError({ timestamp: new Date().toISOString(), block: 0, error: `uncaughtException: ${err.message}` });
  process.exit(1);
});

const runCtx = getRunContext();
const START  = Date.now();

const stats = {
  blocks:     0,
  dexSpread:  { scans: 0, opps: 0, errors: 0 },
  triangular: { scans: 0, opps: 0, errors: 0 },
  cbeth:      { scans: 0, opps: 0, errors: 0 },
  aerodrome:  { scans: 0, opps: 0, errors: 0 },
};

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160,uint32,uint256)',
];

interface BotContext {
  provider:     ethers.WebSocketProvider;
  quoter:       ethers.Contract;
  cbethScanner: CbEthFairValueScanner  | null;
  pairScanner:  ApexPairScanner        | null;
  triScanner:   ApexTriangularScanner  | null;
  aeroScanner:  AerodromeScanner       | null;
}

function buildContext(p: ethers.WebSocketProvider): BotContext {
  const http: ethers.Provider = getHttpProvider() ?? p;
  return {
    provider:     p,
    quoter:       new ethers.Contract(CONFIG.CONTRACTS.UNI_QUOTER, QUOTER_ABI, http),
    cbethScanner: CONFIG.ENABLE_CBETH_SIGNAL     ? new CbEthFairValueScanner(http) : null,
    pairScanner:  CONFIG.ENABLE_DEX_SPREAD_SIGNAL ? new ApexPairScanner(http)       : null,
    triScanner:   CONFIG.ENABLE_TRIANGULAR_SIGNAL ? new ApexTriangularScanner(http) : null,
    aeroScanner:  CONFIG.ENABLE_AERODROME_SIGNAL  ? new AerodromeScanner(http)      : null,
  };
}

let ctx:          BotContext | null = null;
let handlerActive = false;
let fastExec:     FastPathExecutor | null = null;

// Wallet — created once; provider is attached on each (re)connect
const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY!);

let cachedEthPrice = 0n;
let lastEthPriceMs = 0;

async function getEthPrice(quoter: ethers.Contract): Promise<bigint> {
  if (cachedEthPrice > 0n && Date.now() - lastEthPriceMs < CONFIG.ETH_PRICE_CACHE_MS) {
    return cachedEthPrice;
  }
  try {
    const r = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: CONFIG.TOKENS.WETH, tokenOut: CONFIG.TOKENS.USDC,
      amountIn: ethers.parseEther('1'), fee: 3000, sqrtPriceLimitX96: 0,
    });
    cachedEthPrice = r[0];
    lastEthPriceMs = Date.now();
    updateExecutorEthPrice(cachedEthPrice);
    return cachedEthPrice;
  } catch { return cachedEthPrice > 0n ? cachedEthPrice : 3_000_000_000n; }
}

async function main(): Promise<void> {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║         A P E X   U N I F I E D   B O T   — L I V E        ║');
  console.log('║  Atlas thinks  ·  Grok sees  ·  Apex executes                ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log(`  BOT_ID:    ${runCtx.botId}`);
  console.log(`  RUN_ID:    ${runCtx.runId}`);
  console.log(`  CHAIN:     Base (${runCtx.chainId})`);
  console.log(`  MODE:      LIVE EXECUTION — real transactions enabled`);
  console.log(`  CONTRACT:  ${CONFIG.CONTRACTS.APEX_FLASH_LOAN}`);
  console.log(`  WALLET:    ${wallet.address}`);
  console.log('');

  if (!acquireLock()) {
    logger.error('MAIN', 'Another instance is running on this chain — exiting');
    process.exit(1);
  }

  await initTelegram();

  if (CONFIG.BASE_HTTPS_URL) {
    fastExec = new FastPathExecutor({
      wallet:      wallet,
      primaryRpc:  CONFIG.BASE_HTTPS_URL,
      sequencerRpc: CONFIG.BASE_SEQUENCER_URL,
      chainId:     CONFIG.CHAIN_ID,
      contract:    CONFIG.CONTRACTS.APEX_FLASH_LOAN,
      abi:         APEX_ABI,
    });
    await fastExec.init();
    logger.info('MAIN', 'FastPathExecutor active with wallet — live trades via dual-broadcast');
  } else {
    logger.warn('MAIN', 'BASE_HTTPS_URL not set — FastPathExecutor disabled; falling back to slow path');
  }

  if (CONFIG.ENABLE_CEX_CONTEXT && (CONFIG.ENABLE_BINANCE || CONFIG.ENABLE_KRAKEN)) {
    const active = [CONFIG.ENABLE_BINANCE && 'Binance', CONFIG.ENABLE_KRAKEN && 'Kraken'].filter(Boolean).join(', ');
    logger.info('MAIN', `Starting CEX feeds: ${active}...`);
    getCexFeed();
    await new Promise(r => setTimeout(r, 2_000));
  } else if (CONFIG.ENABLE_CEX_CONTEXT) {
    logger.warn('MAIN', 'All CEX feeds disabled — using CoinGecko REST fallback only');
  }

  const monitorAddress = wallet.address;
  let   initialBalSet  = false;
  let   firstConnect   = true;

  const rws = new ResilientWsProvider(CONFIG.ALCHEMY_WSS_URL, CONFIG.CHAIN_ID);

  rws.onConnect(async (provider) => {
    const connectedWallet = wallet.connect(provider);
    ctx            = buildContext(provider);
    cachedEthPrice = 0n;
    lastEthPriceMs = 0;

    // Wire live execution with fresh provider + wallet on every (re)connect
    setupExecutor(connectedWallet, provider, fastExec, cachedEthPrice);

    if (firstConnect) {
      const httpOrWs: ethers.Provider = getHttpProvider() ?? provider;
      runStartupValidation(httpOrWs).catch((e: any) =>
        logger.warn('MAIN', `Startup validation error: ${e.message}`)
      );
    }

    if (!initialBalSet) {
      try {
        const bal = await provider.getBalance(monitorAddress);
        setInitialBalance(bal);
        initialBalSet = true;
        logger.info('MAIN', `Wallet ${monitorAddress} balance: ${ethers.formatEther(bal)} ETH`);
      } catch (e: any) {
        logger.warn('MAIN', `Could not read wallet balance: ${e.message}`);
      }
    }

    if (!firstConnect) sendAlert('WebSocket reconnected — live trading resumed');
    firstConnect = false;
  });

  rws.on('block', async (blockNum: number) => {
    if (handlerActive || !ctx) {
      if (handlerActive) logger.debug('MAIN', `Block ${blockNum} skipped — previous scan still running`);
      return;
    }
    handlerActive = true;
    stats.blocks++;
    fastExec?.onBlock(blockNum);   // ResilientWsProvider already called setCachedBlock

    try {
      const ethPrice = await getEthPrice(ctx.quoter);

      const [cbethResult, pairResult, triResult, aeroResult] = await Promise.all([
        ctx.cbethScanner?.scan(getHttpProvider() ?? ctx.provider, blockNum) ?? Promise.resolve(null),
        ctx.pairScanner?.scan(blockNum, ethPrice)      ?? Promise.resolve(null),
        ctx.triScanner?.scan(blockNum, ethPrice)       ?? Promise.resolve(null),
        ctx.aeroScanner?.scan(blockNum, ethPrice)      ?? Promise.resolve(null),
      ]);

      if (cbethResult)  { stats.cbeth.scans      += cbethResult.scanned;  stats.cbeth.opps      += cbethResult.opportunities.length;  stats.cbeth.errors      += cbethResult.errors; }
      if (pairResult)   { stats.dexSpread.scans  += pairResult.scanned;   stats.dexSpread.opps  += pairResult.opportunities.length;   stats.dexSpread.errors  += pairResult.errors; }
      if (triResult)    { stats.triangular.scans += triResult.scanned;    stats.triangular.opps += triResult.opportunities.length;    stats.triangular.errors += triResult.errors; }
      if (aeroResult)   { stats.aerodrome.scans  += aeroResult.scanned;   stats.aerodrome.opps  += aeroResult.opportunities.length;   stats.aerodrome.errors  += aeroResult.errors; }

      if (stats.blocks % 50 === 0) {
        const up = uptime(START);
        logger.info('SCAN',
          `${up} | block=${blockNum} | ` +
          `cbeth=${stats.cbeth.opps}/${stats.cbeth.scans} ` +
          `dex=${stats.dexSpread.opps}/${stats.dexSpread.scans} ` +
          `tri=${stats.triangular.opps}/${stats.triangular.scans} ` +
          `aero=${stats.aerodrome.opps}/${stats.aerodrome.scans}`,
        );
      }
    } catch (err: any) {
      logError({ timestamp: new Date().toISOString(), block: blockNum, error: err.message });
      logger.error('BLOCK', `Block ${blockNum} scan failed: ${err.message}`);
    } finally {
      handlerActive = false;
    }
  });

  if (monitorAddress) {
    setInterval(() => {
      try { checkCircuitBreaker(rws.provider, monitorAddress); } catch {}
    }, 30_000);
  }

  setInterval(() => {
    const up = uptime(START);
    const summary = {
      timestamp:   new Date().toISOString(),
      run_id:      runCtx.runId,
      uptime:      up,
      blocks:      stats.blocks,
      cbeth_opps:  stats.cbeth.opps,
      dex_opps:    stats.dexSpread.opps,
      tri_opps:    stats.triangular.opps,
      aero_opps:   stats.aerodrome.opps,
      total_opps:  stats.cbeth.opps + stats.dexSpread.opps + stats.triangular.opps + stats.aerodrome.opps,
      errors:      stats.cbeth.errors + stats.dexSpread.errors + stats.triangular.errors + stats.aerodrome.errors,
    };
    logSummary(summary);
    logger.info('HOURLY',
      `${up} | blocks=${stats.blocks} | ` +
      `total_opps=${summary.total_opps} ` +
      `(cbeth=${stats.cbeth.opps} dex=${stats.dexSpread.opps} tri=${stats.triangular.opps} aero=${stats.aerodrome.opps}) ` +
      `errors=${summary.errors}`,
    );
    sendAlert(
      `[LIVE] Hourly summary — ${up}\n` +
      `Blocks: ${stats.blocks}\n` +
      `DEX spread opps executed: ${stats.dexSpread.opps}\n` +
      `Triangular opps: ${stats.triangular.opps}\n` +
      `cbETH opps: ${stats.cbeth.opps}\n` +
      `Aerodrome opps: ${stats.aerodrome.opps}`,
    );
  }, 60 * 60 * 1_000);

  async function shutdown(signal: string) {
    logger.info('MAIN', `${signal} received — shutting down`);
    await rws.destroy();
    process.exit(0);
  }
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info('MAIN', 'Connecting to Base via WebSocket — LIVE MODE');
  await rws.start();
  logger.info('MAIN', 'Connected — live scanning started');
}

main().catch(err => {
  logger.error('FATAL', err.message);
  alertError(err.message);
  process.exit(1);
});
