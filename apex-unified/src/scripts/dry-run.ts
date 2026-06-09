import CONFIG                     from '../core/config';
import { assertDryRunMode }        from '../core/safety';
import { getRunContext, uptime }   from '../core/runContext';
import { logger }                  from '../core/logger';
import { logSummary, logError }    from '../core/jsonlLogger';
import { createWsProvider }        from '../core/rpcHealth';
import { initTelegram, sendAlert, alertError } from '../infrastructure/telegramAlert';
import { getCexFeed }              from '../signals/cexContextSignal';
import { CbEthFairValueScanner }   from '../scanners/cbETHFairValueScanner';
import { ApexPairScanner }         from '../scanners/apexPairScanner';
import { ApexTriangularScanner }   from '../scanners/apexTriangularScanner';
import { AerodromeScanner }        from '../scanners/aerodromeScanner';
import { checkCircuitBreaker, setInitialBalance } from '../risk/circuitBreaker';
import { acquireLock }             from '../risk/networkMutex';
import { ethers }                  from 'ethers';

// ── Safety first ──────────────────────────────────────────────────────────────
assertDryRunMode();

if (parseInt(process.env.CHAIN_ID ?? '8453', 10) !== 8453) {
  throw new Error(`CHAIN_ID must be 8453 (Base), got ${process.env.CHAIN_ID}`);
}

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
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

// ── Mutable state shared across reconnects ────────────────────────────────────
let currentProvider: ethers.WebSocketProvider;
let handlerActive  = false;
let lastBlockMs    = Date.now();
let reconnecting   = false;

// ── Fallback RPC (set FALLBACK_RPC_URL in .env to enable) ────────────────────
const PRIMARY_URL  = CONFIG.ALCHEMY_WSS_URL;
const FALLBACK_URL = process.env.FALLBACK_RPC_URL ?? '';

// Switch to fallback after 3 failures within 60 s; retry primary after 5 min
const FAILURE_WINDOW_MS   = 60_000;
const FAILURE_THRESHOLD   = 3;
const FALLBACK_RECOVER_MS = 300_000;

let wsFailureTimes: number[] = [];
let usingFallback  = false;
let fallbackSince  = 0;

function recordWsFailure(): void {
  const now = Date.now();
  wsFailureTimes = wsFailureTimes.filter(t => now - t < FAILURE_WINDOW_MS);
  wsFailureTimes.push(now);
}

function activeRpcUrl(): string {
  if (!FALLBACK_URL) return PRIMARY_URL;

  if (usingFallback) {
    if (Date.now() - fallbackSince > FALLBACK_RECOVER_MS) {
      logger.info('MAIN', 'Attempting to restore primary RPC...');
      usingFallback = false;
      wsFailureTimes = [];
    } else {
      return FALLBACK_URL;
    }
  }

  if (wsFailureTimes.length >= FAILURE_THRESHOLD) {
    usingFallback = true;
    fallbackSince = Date.now();
    logger.warn('MAIN', `${FAILURE_THRESHOLD} WS failures in ${FAILURE_WINDOW_MS / 1000}s — switching to fallback RPC`);
    sendAlert('Switched to fallback RPC — primary throttled');
    return FALLBACK_URL;
  }

  return PRIMARY_URL;
}

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160,uint32,uint256)',
];

// ── Provider context (recreated on each reconnect) ────────────────────────────
interface BotContext {
  provider:     ethers.WebSocketProvider;
  quoter:       ethers.Contract;
  cbethScanner: CbEthFairValueScanner  | null;
  pairScanner:  ApexPairScanner        | null;
  triScanner:   ApexTriangularScanner  | null;
  aeroScanner:  AerodromeScanner       | null;
}

function buildContext(p: ethers.WebSocketProvider): BotContext {
  return {
    provider:     p,
    quoter:       new ethers.Contract(CONFIG.CONTRACTS.UNI_QUOTER, QUOTER_ABI, p),
    cbethScanner: CONFIG.ENABLE_CBETH_SIGNAL      ? new CbEthFairValueScanner(p)  : null,
    pairScanner:  CONFIG.ENABLE_DEX_SPREAD_SIGNAL  ? new ApexPairScanner(p)        : null,
    triScanner:   CONFIG.ENABLE_TRIANGULAR_SIGNAL  ? new ApexTriangularScanner(p)  : null,
    aeroScanner:  CONFIG.ENABLE_AERODROME_SIGNAL   ? new AerodromeScanner(p)       : null,
  };
}

function registerHandlers(ctx: BotContext): void {
  handlerActive = false;

  // Per-context ETH price cache (reset on reconnect is fine)
  let cachedEthPrice = 0n;
  let lastEthPriceMs = 0;

  async function getEthPrice(): Promise<bigint> {
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

  // Update heartbeat timestamp on every block
  ctx.provider.on('block', () => { lastBlockMs = Date.now(); });

  // Main block handler
  ctx.provider.on('block', async (blockNum: number) => {
    if (handlerActive) {
      logger.debug('MAIN', `Block ${blockNum} skipped — previous scan still running`);
      return;
    }
    handlerActive = true;
    stats.blocks++;

    try {
      const ethPrice = await getEthPrice();

      const [cbethResult, pairResult, triResult, aeroResult] = await Promise.all([
        ctx.cbethScanner?.scan(ctx.provider, blockNum) ?? Promise.resolve(null),
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
          `aero=${stats.aerodrome.opps}/${stats.aerodrome.scans}`
        );
      }
    } catch (err: any) {
      logError({ timestamp: new Date().toISOString(), block: blockNum, error: err.message });
      logger.error('BLOCK', `Block ${blockNum} scan failed: ${err.message}`);
    } finally {
      handlerActive = false;
    }
  });
}

// ── WebSocket reconnect ───────────────────────────────────────────────────────
async function reconnect(): Promise<void> {
  if (reconnecting) return;
  reconnecting = true;
  recordWsFailure();
  const url = activeRpcUrl();
  logger.warn('MAIN', `Reconnecting WebSocket (${usingFallback ? 'FALLBACK' : 'primary'})...`);
  try {
    try { await currentProvider.destroy(); } catch { /* ignore */ }
    currentProvider = await createWsProvider(url, () => { reconnect().catch(() => {}); });
    const ctx = buildContext(currentProvider);
    registerHandlers(ctx);
    lastBlockMs = Date.now();
    logger.info('MAIN', 'WebSocket reconnected — scanning resumed');
    sendAlert('WebSocket reconnected — dry run resumed');
  } catch (err: any) {
    logger.error('MAIN', `Reconnect failed: ${err.message} — will retry in 30s`);
    alertError(`Reconnect failed: ${err.message}`);
    lastBlockMs = Date.now() - 25_000;
  } finally {
    reconnecting = false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
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

  if (!acquireLock()) {
    logger.error('MAIN', 'Another instance is running on this chain — exiting');
    process.exit(1);
  }

  await initTelegram();
  sendAlert(`ApexUnified started\nRun ID: ${runCtx.runId}\nMode: DRY RUN\nChain: Base`);

  if (CONFIG.ENABLE_CEX_CONTEXT) {
    logger.info('MAIN', 'Starting Binance CEX feed...');
    getCexFeed();
    await new Promise(r => setTimeout(r, 2_000));
  }

  logger.info('MAIN', 'Connecting to Base via WebSocket...');
  currentProvider = await createWsProvider(PRIMARY_URL, () => { reconnect().catch(() => {}); });
  logger.info('MAIN', 'Connected');

  const ctx = buildContext(currentProvider);
  registerHandlers(ctx);

  // ── Circuit breaker ───────────────────────────────────────────────────────
  const monitorAddress = process.env.WALLET_ADDRESS ?? process.env.MONITOR_ADDRESS ?? '';
  if (monitorAddress) {
    const initBal = await currentProvider.getBalance(monitorAddress);
    setInitialBalance(initBal);
    setInterval(() => checkCircuitBreaker(currentProvider, monitorAddress), 30_000);
  }

  // ── Hourly summary ────────────────────────────────────────────────────────
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
      `errors=${summary.errors}`
    );
    sendAlert(
      `Hourly summary — ${up}\n` +
      `Blocks: ${stats.blocks}\n` +
      `cbETH opps: ${stats.cbeth.opps}\n` +
      `DEX spread opps: ${stats.dexSpread.opps}\n` +
      `Triangular opps: ${stats.triangular.opps}\n` +
      `Aerodrome opps: ${stats.aerodrome.opps}`
    );
  }, 60 * 60 * 1_000);

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  async function shutdown(signal: string) {
    logger.info('MAIN', `${signal} received — shutting down`);
    try { await currentProvider.destroy(); } catch { /* ignore */ }
    process.exit(0);
  }
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // ── WebSocket heartbeat + auto-reconnect ──────────────────────────────────
  setInterval(async () => {
    const silentMs = Date.now() - lastBlockMs;
    if (silentMs > 30_000) {
      const msg = `No block in ${Math.round(silentMs / 1000)}s — reconnecting`;
      logger.error('MAIN', msg);
      sendAlert(msg);
      await reconnect();
    }
  }, 15_000);
}

main().catch(err => {
  logger.error('FATAL', err.message);
  alertError(err.message);
  process.exit(1);
});
