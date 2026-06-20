import CONFIG                     from '../core/config';
import { assertDryRunMode }        from '../core/safety';
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
import { getHttpProvider }         from '../infrastructure/fallbackProvider';
import { runStartupValidation }    from '../core/startupValidator';
import { ethers }                  from 'ethers';

const APEX_ABI = [
  'function executeArbitrage(address flashToken, uint256 flashAmount, address uniV3Router, bytes calldata path, uint256 minAmountOut) external',
];

// ── Safety first ──────────────────────────────────────────────────────────────
assertDryRunMode();

if (parseInt(process.env.CHAIN_ID ?? '8453', 10) !== 8453) {
  throw new Error(`CHAIN_ID must be 8453 (Base), got ${process.env.CHAIN_ID}`);
}

// Provider errors, CEX feed reconnects, and gas forecaster failures surface here.
// Rate-limit errors (code 15 / "Too many request") on eth_subscribe surface here as
// unhandled rejections from ethers internals — mark the RPC health so the socket
// close handler uses the rate-limit backoff floor instead of reconnecting immediately.
process.on('unhandledRejection', (reason) => {
  const errCode = (reason as any)?.error?.code;
  const msg     = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  const isRateLimit = errCode === 15
    || msg.toLowerCase().includes('too many request')
    || msg.toLowerCase().includes('rate limit');

  if (isRateLimit) {
    rpcHealth.mark429();
    logger.warn('RPC', 'Rate-limit on eth_subscribe (code 15) — RWS will back off and reconnect');
    return; // Not a crash — ResilientWsProvider handles the socket close + retry
  }

  logger.error('FATAL', `unhandledRejection: ${msg}`);
  logError({ timestamp: new Date().toISOString(), block: 0, error: `unhandledRejection: ${msg}` });
  // Do NOT exit — let the ResilientWsProvider's reconnect loop handle provider failures.
});

process.on('uncaughtException', (err) => {
  logger.error('FATAL', `uncaughtException: ${err.stack ?? err.message}`);
  logError({ timestamp: new Date().toISOString(), block: 0, error: `uncaughtException: ${err.message}` });
  // Exit on uncaught synchronous exceptions — these indicate a coding bug, not a transient failure.
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
  // Route all RPC reads (quotes, Chainlink calls) through the HTTP FallbackProvider when
  // BASE_HTTPS_URL(S) is configured, so a WebSocket stall doesn't blind quoting.
  // Falls back to the WSS provider transparently if no HTTP URL is set.
  const http: ethers.Provider = getHttpProvider() ?? p;
  return {
    provider:     p,
    quoter:       new ethers.Contract(CONFIG.CONTRACTS.UNI_QUOTER, QUOTER_ABI, http),
    cbethScanner: CONFIG.ENABLE_CBETH_SIGNAL       ? new CbEthFairValueScanner(http) : null,
    pairScanner:  CONFIG.ENABLE_DEX_SPREAD_SIGNAL   ? new ApexPairScanner(http)       : null,
    triScanner:   CONFIG.ENABLE_TRIANGULAR_SIGNAL   ? new ApexTriangularScanner(http) : null,
    aeroScanner:  CONFIG.ENABLE_AERODROME_SIGNAL    ? new AerodromeScanner(http)      : null,
  };
}

// ── Module-level state ──────────────────────────────────────────────────
let ctx:           BotContext | null = null;
let handlerActive  = false;
let fastExec:      FastPathExecutor | null = null;

// ETH price cache — reset on reconnect (new provider = new quoter)
let cachedEthPrice = 0n;
let lastEthPriceMs = 0;

async function getEthPrice(): Promise<bigint> {
  if (!ctx) return 3_000_000_000n;
  if (cachedEthPrice > 0n && Date.now() - lastEthPriceMs < CONFIG.ETH_PRICE_CACHE_MS) {
    return cachedEthPrice;
  }
  try {
    const r = await ctx.quoter.quoteExactInputSingle.staticCall({
      tokenIn: CONFIG.TOKENS.WETH, tokenOut: CONFIG.TOKENS.USDC,
      amountIn: ethers.parseEther('1'), fee: 3000, sqrtPriceLimitX96: 0,
    });
    cachedEthPrice = r[0];
    lastEthPriceMs = Date.now();
    return cachedEthPrice;
  } catch { return 3_000_000_000n; }
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║         A P E X   U N I F I E D   B O T                     ║');
  console.log('║  Atlas thinks  ·  Grok sees  ·  Apex executes                ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log(`  BOT_ID:      ${runCtx.botId}`);
  console.log(`  RUN_ID:      ${runCtx.runId}`);
  console.log(`  CHAIN:       Base (${runCtx.chainId})`);
  console.log(`  MODE:        DRY RUN — zero transactions`);
  console.log(`  Strategies:  ${[
    CONFIG.ENABLE_DEX_SPREAD_SIGNAL  ? 'apex.dex_spread'         : '',
    CONFIG.ENABLE_TRIANGULAR_SIGNAL  ? 'apex.triangular'         : '',
    CONFIG.ENABLE_CBETH_SIGNAL       ? 'grok.cbeth_fair_value'   : '',
    CONFIG.ENABLE_AERODROME_SIGNAL   ? 'apex.aerodrome_spread'   : '',
  ].filter(Boolean).join(', ')}`);
  console.log('');

  if (CONFIG.ALCHEMY_WSS_URL.includes('alchemy.com')) {
    logger.warn('MAIN',
      'Alchemy RPC detected — if you hit 429 throttle errors, switch to free drpc.org: ' +
      'update ALCHEMY_WSS_URL=wss://base.drpc.org in .env (no account needed)'
    );
  }

  if (!acquireLock()) {
    logger.error('MAIN', 'Another instance is running on this chain — exiting');
    process.exit(1);
  }

  await initTelegram(); // sends probe message on success; disables silently on failure

  // FastPathExecutor for fee-cache warming (no wallet in dry run — execute() is a no-op)
  if (CONFIG.BASE_HTTPS_URL) {
    fastExec = new FastPathExecutor({
      primaryRpc:   CONFIG.BASE_HTTPS_URL,
      sequencerRpc: CONFIG.BASE_SEQUENCER_URL,
      chainId:      CONFIG.CHAIN_ID,
      contract:     CONFIG.CONTRACTS.APEX_FLASH_LOAN,
      abi:          APEX_ABI,
    });
    await fastExec.init();
    logger.info('MAIN', 'FastPathExecutor active — fee cache will warm each block');
  } else {
    logger.warn('MAIN', 'BASE_HTTPS_URL not set — FastPathExecutor disabled (add to .env)');
  }

  if (CONFIG.ENABLE_CEX_CONTEXT && CONFIG.ENABLE_BINANCE) {
    logger.info('MAIN', 'Starting Binance CEX feed...');
    getCexFeed();
    await new Promise(r => setTimeout(r, 2_000));
  } else if (CONFIG.ENABLE_CEX_CONTEXT && !CONFIG.ENABLE_BINANCE) {
    logger.warn('MAIN', 'ENABLE_BINANCE=false — CEX feed disabled (Hetzner geo-blocked; set true if your IP allows Binance)');
  }

  const monitorAddress  = process.env.WALLET_ADDRESS ?? process.env.MONITOR_ADDRESS ?? '';
  let   initialBalSet   = false;
  let   firstConnect    = true;

  // ── ResilientWsProvider ──────────────────────────────────────────────
  const rws = new ResilientWsProvider(CONFIG.ALCHEMY_WSS_URL, CONFIG.CHAIN_ID);

  // Rebuild scan context on every (re)connect — scanners hold provider refs
  rws.onConnect(async (provider) => {
    ctx            = buildContext(provider);
    cachedEthPrice = 0n;
    lastEthPriceMs = 0;

    // Run startup validation once on first connect (non-blocking — populates pool
    // filter over ~30s; scans run permissively until validation completes)
    if (firstConnect) {
      const httpOrWs: ethers.Provider = getHttpProvider() ?? provider;
      runStartupValidation(httpOrWs).catch((e: any) =>
        logger.warn('MAIN', `Startup validation error: ${e.message}`)
      );
    }

    // Circuit breaker: set baseline balance only on first connect
    if (monitorAddress && !initialBalSet) {
      try {
        const bal = await provider.getBalance(monitorAddress);
        setInitialBalance(bal);
        initialBalSet = true;
      } catch (e: any) {
        logger.warn('MAIN', `Could not read initial balance: ${e.message}`);
      }
    }

    if (!firstConnect) sendAlert('WebSocket reconnected — dry run resumed');
    firstConnect = false;
  });

  // Main block handler — registered on rws, replayed on every reconnect
  rws.on('block', async (blockNum: number) => {
    if (handlerActive || !ctx) {
      if (handlerActive) logger.debug('MAIN', `Block ${blockNum} skipped — previous scan still running`);
      return;
    }
    handlerActive = true;
    stats.blocks++;
    fastExec?.onBlock(blockNum); // fee-cache warmup — fire-and-forget

    try {
      const ethPrice = await getEthPrice();

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

  // ── Circuit breaker polling ─────────────────────────────────────────────
  if (monitorAddress) {
    setInterval(() => {
      // rws.provider may be null/stale during reconnect — skip silently
      try { checkCircuitBreaker(rws.provider, monitorAddress); } catch {}
    }, 30_000);
  }

  // ── Hourly summary ──────────────────────────────────────────────────────
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
      `Hourly summary — ${up}\n` +
      `Blocks: ${stats.blocks}\n` +
      `cbETH opps: ${stats.cbeth.opps}\n` +
      `DEX spread opps: ${stats.dexSpread.opps}\n` +
      `Triangular opps: ${stats.triangular.opps}\n` +
      `Aerodrome opps: ${stats.aerodrome.opps}`,
    );
  }, 60 * 60 * 1_000);

  // ── Graceful shutdown ──────────────────────────────────────────────────
  async function shutdown(signal: string) {
    logger.info('MAIN', `${signal} received — shutting down`);
    await rws.destroy();
    process.exit(0);
  }
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // ── Connect ──────────────────────────────────────────────────────────────
  logger.info('MAIN', 'Connecting to Base via WebSocket...');
  await rws.start();
  logger.info('MAIN', 'Connected — scanning started');
}

main().catch(err => {
  logger.error('FATAL', err.message);
  alertError(err.message);
  process.exit(1);
});
