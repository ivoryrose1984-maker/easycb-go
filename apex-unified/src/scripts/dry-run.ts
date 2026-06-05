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
import { getGasForecast }          from '../execution/gasForecaster';
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

const ctx   = getRunContext();
const START = Date.now();

const stats = {
  blocks:        0,
  dexSpread:     { scans: 0, opps: 0, errors: 0 },
  triangular:    { scans: 0, opps: 0, errors: 0 },
  cbeth:         { scans: 0, opps: 0, errors: 0 },
  aerodrome:     { scans: 0, opps: 0, errors: 0 },
};

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║         A P E X   U N I F I E D   B O T                     ║');
  console.log('║  Atlas thinks  ·  Grok sees  ·  Apex executes                ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log(`  BOT_ID:      ${ctx.botId}`);
  console.log(`  RUN_ID:      ${ctx.runId}`);
  console.log(`  CHAIN:       Base (${ctx.chainId})`);
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
  sendAlert(`ApexUnified started\nRun ID: ${ctx.runId}\nMode: DRY RUN\nChain: Base`);

  if (CONFIG.ENABLE_CEX_CONTEXT) {
    logger.info('MAIN', 'Starting Binance CEX feed...');
    getCexFeed();
    await new Promise(r => setTimeout(r, 2_000));
  }

  logger.info('MAIN', 'Connecting to Base via WebSocket...');
  const provider = await createWsProvider(CONFIG.ALCHEMY_WSS_URL);
  logger.info('MAIN', 'Connected');

  const cbethScanner  = CONFIG.ENABLE_CBETH_SIGNAL      ? new CbEthFairValueScanner(provider)  : null;
  const pairScanner   = CONFIG.ENABLE_DEX_SPREAD_SIGNAL  ? new ApexPairScanner(provider)        : null;
  const triScanner    = CONFIG.ENABLE_TRIANGULAR_SIGNAL  ? new ApexTriangularScanner(provider)  : null;
  const aeroScanner   = CONFIG.ENABLE_AERODROME_SIGNAL   ? new AerodromeScanner(provider)       : null;

  const QUOTER_ABI = [
    'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160,uint32,uint256)',
  ];
  const quoter = new ethers.Contract(CONFIG.CONTRACTS.UNI_QUOTER, QUOTER_ABI, provider);

  let cachedEthPrice    = 0n;
  let lastEthPriceMs    = 0;

  async function getEthPrice(): Promise<bigint> {
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
      return cachedEthPrice;
    } catch { return 3_000_000_000n; }
  }

  // ── Block loop ───────────────────────────────────────────────────────────────
  let handlerActive = false;
  provider.on('block', async (blockNum: number) => {
    if (handlerActive) {
      logger.debug('MAIN', `Block ${blockNum} skipped — previous scan still running`);
      return;
    }
    handlerActive = true;
    stats.blocks++;

    try {
      const ethPrice = await getEthPrice();

      const [cbethResult, pairResult, triResult, aeroResult] = await Promise.all([
        cbethScanner?.scan(provider, blockNum)    ?? Promise.resolve(null),
        pairScanner?.scan(blockNum, ethPrice)     ?? Promise.resolve(null),
        triScanner?.scan(blockNum, ethPrice)      ?? Promise.resolve(null),
        aeroScanner?.scan(blockNum, ethPrice)     ?? Promise.resolve(null),
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

  // ── Circuit breaker check every 30s (live only — dry run has no wallet balance) ─
  const monitorAddress = process.env.WALLET_ADDRESS ?? process.env.MONITOR_ADDRESS ?? '';
  if (monitorAddress) {
    const initBal = await provider.getBalance(monitorAddress);
    setInitialBalance(initBal);
    setInterval(() => checkCircuitBreaker(provider, monitorAddress), 30_000);
  }

  // ── Hourly summary ────────────────────────────────────────────────────────────
  setInterval(() => {
    const up = uptime(START);
    const summary = {
      timestamp:     new Date().toISOString(),
      run_id:        ctx.runId,
      uptime:        up,
      blocks:        stats.blocks,
      cbeth_opps:    stats.cbeth.opps,
      dex_opps:      stats.dexSpread.opps,
      tri_opps:      stats.triangular.opps,
      aero_opps:     stats.aerodrome.opps,
      total_opps:    stats.cbeth.opps + stats.dexSpread.opps + stats.triangular.opps + stats.aerodrome.opps,
      errors:        stats.cbeth.errors + stats.dexSpread.errors + stats.triangular.errors + stats.aerodrome.errors,
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

  // ── Graceful shutdown ─────────────────────────────────────────────────────────
  async function shutdown(signal: string) {
    logger.info('MAIN', `${signal} received — shutting down`);
    await provider.destroy();
    process.exit(0);
  }
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // ── WebSocket heartbeat — alert if blocks stop arriving (silent WS death) ────
  let lastBlockMs = Date.now();
  provider.on('block', () => { lastBlockMs = Date.now(); });
  setInterval(() => {
    const silentMs = Date.now() - lastBlockMs;
    if (silentMs > 30_000) {
      const msg = `No block received in ${Math.round(silentMs / 1000)}s — WebSocket may be dead`;
      logger.error('MAIN', msg);
      sendAlert(msg);
    }
  }, 15_000);
}

main().catch(err => {
  logger.error('FATAL', err.message);
  alertError(err.message);
  process.exit(1);
});
