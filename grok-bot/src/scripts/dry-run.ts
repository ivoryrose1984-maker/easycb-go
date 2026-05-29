import { ENV }                from '../config/env';
import { assertDryRunMode }  from '../risk/ExecutionSafetyGate';
import { CbEthEngine }       from '../strategies/cbeth/CbEthEngine';
import { getCexFeed }        from '../strategies/cex/BinanceFeed';
import { log }               from '../infrastructure/jsonlLogger';
import { initTelegram, sendAlert } from '../infrastructure/telegramAlert';
import { ethers }            from 'ethers';

// ── Safety first ────────────────────────────────────────────────────────────
assertDryRunMode();

// ── Stats ────────────────────────────────────────────────────────────────────
const stats = { blocks: 0, opportunities: 0, skipped: 0, rpcErrors: 0 };
const START = Date.now();

function uptime(): string {
  const s = Math.floor((Date.now() - START) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h${m}m`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║            G R O K   B O T                      ║');
  console.log('║  cbETH Fair-Value + CEX Signal + Time-of-Day    ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  BOT_ID:      ${ENV.BOT_ID}`);
  console.log(`  STRATEGY_ID: ${ENV.STRATEGY_ID}`);
  console.log(`  RUN_ID:      ${ENV.RUN_ID}`);
  console.log(`  CHAIN:       Base (${ENV.CHAIN_ID})`);
  console.log(`  MODE:        DRY RUN — zero transactions`);
  console.log(`  THRESHOLD:   ${ENV.MIN_NET_EDGE_BPS}bps (time-adjusted)`);
  console.log('');

  await initTelegram();
  sendAlert(`GrokBot started\nRun ID: ${ENV.RUN_ID}\nMode: DRY RUN`);

  // Start CEX feed before connecting to chain
  const cex = getCexFeed();
  console.log('[CEX] Binance feed starting...');
  await new Promise(r => setTimeout(r, 2_000)); // let feed connect

  // Connect to Base
  console.log('[RPC] Connecting to Base...');
  const provider = new ethers.WebSocketProvider(ENV.ALCHEMY_WSS_URL);
  await provider.getBlockNumber(); // verify connection
  console.log('[RPC] ✅ Connected to Base\n');

  const engine = new CbEthEngine(provider);

  // Scan every block
  provider.on('block', async (blockNum: number) => {
    stats.blocks++;

    const signal = await engine.scan(provider);

    if (!signal) {
      stats.rpcErrors++;
      log.error({ timestamp: new Date().toISOString(), block: blockNum, error: 'scan_failed' });
      return;
    }

    // Log every single scan to JSONL — full audit trail
    log.signal(signal as unknown as Record<string, unknown>);

    if (signal.opportunity) {
      stats.opportunities++;
      log.opportunity(signal as unknown as Record<string, unknown>);

      console.log(
        `\n[OPPORTUNITY] block=${blockNum}` +
        `\n  gross=${signal.gross_edge_bps.toFixed(2)}bps` +
        `  net=${signal.net_edge_bps.toFixed(2)}bps` +
        `  threshold=${signal.effective_threshold_bps}bps (${signal.competition_label})` +
        `\n  cex_triggered=${signal.cex_triggered}` +
        `  hash=${signal.opportunity_hash}` +
        `\n  [DRY RUN — not executed]\n`
      );

      sendAlert(
        `Opportunity detected\nGross: ${signal.gross_edge_bps.toFixed(2)}bps\n` +
        `Net: ${signal.net_edge_bps.toFixed(2)}bps\n` +
        `Block: ${blockNum}\nHash: ${signal.opportunity_hash}\n[DRY Run]`
      );
    } else {
      stats.skipped++;

      if (stats.blocks % 50 === 0) {
        console.log(
          `[SCAN] ${uptime()} | blocks=${stats.blocks} opps=${stats.opportunities} ` +
          `errors=${stats.rpcErrors} | ` +
          `gross=${signal.gross_edge_bps.toFixed(2)}bps net=${signal.net_edge_bps.toFixed(2)}bps ` +
          `window=${signal.competition_label}(×${signal.competition_multiplier}) ` +
          `cex=${signal.cex_eth_mid?.toFixed(2) ?? 'n/a'}`
        );
      }
    }
  });

  // Hourly summary
  setInterval(() => {
    const summary = {
      timestamp:     new Date().toISOString(),
      run_id:        ENV.RUN_ID,
      uptime:        uptime(),
      blocks:        stats.blocks,
      opportunities: stats.opportunities,
      skipped:       stats.skipped,
      rpc_errors:    stats.rpcErrors,
      opp_rate_pct:  stats.blocks > 0
        ? ((stats.opportunities / stats.blocks) * 100).toFixed(3)
        : '0',
    };

    log.summary(summary);

    console.log(
      `\n[HOURLY] ${uptime()} | blocks=${stats.blocks} opps=${stats.opportunities} ` +
      `opp_rate=${summary.opp_rate_pct}% rpc_errors=${stats.rpcErrors}\n`
    );

    sendAlert(
      `Hourly summary — ${uptime()}\n` +
      `Blocks: ${stats.blocks}\nOpportunities: ${stats.opportunities}\n` +
      `Opp rate: ${summary.opp_rate_pct}%\nRPC errors: ${stats.rpcErrors}`
    );
  }, 60 * 60 * 1_000);
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
