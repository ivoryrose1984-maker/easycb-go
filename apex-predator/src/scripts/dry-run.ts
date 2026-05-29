import * as dotenv from 'dotenv';
dotenv.config({ path: process.env.NODE_ENV === 'production' ? '.env.mainnet' : '.env.testnet' });

import { ethers }                from 'ethers';
import { randomUUID }            from 'crypto';
import { createWsProvider }      from '../infrastructure/wsProvider';
import { CbEthFairValueEngine }  from '../strategies/cbeth/CbEthFairValueEngine';
import { logCbEthSignal }        from '../infrastructure/jsonlLogger';
import { checkExecutionAllowed } from '../risk/ExecutionSafetyGate';
import { initTelegram, sendAlert } from '../infrastructure/telegramAlert';

// ── Safety gate ─────────────────────────────────────────────────────────────
const DRY_RUN   = process.env.DRY_RUN   !== 'false';   // true unless explicitly false
const ALLOW_LIVE = process.env.ALLOW_LIVE === 'true';   // false unless explicitly true

const gate = checkExecutionAllowed({ dryRun: DRY_RUN, allowLive: ALLOW_LIVE, chainId: 8453 });
if (gate.allowed) {
  // Should never reach here during dry-run phase
  console.error('FATAL: Safety gate allowed live execution in dry-run script. Exiting.');
  process.exit(1);
}
console.log(`[GATE] ${gate.reason}`);

// ── Identity ─────────────────────────────────────────────────────────────────
const BOT_ID      = process.env.BOT_ID      ?? 'apex-predator';
const STRATEGY_ID = process.env.STRATEGY_ID ?? 'cbeth_fair_value_base';
const RUN_ID      = process.env.RUN_ID      ?? randomUUID();

// ── Config ───────────────────────────────────────────────────────────────────
const WSS_URL         = process.env.ALCHEMY_WSS_URL ?? '';
const MIN_NET_EDGE_BPS = parseInt(process.env.MIN_NET_EDGE_BPS ?? '5', 10);

if (!WSS_URL) {
  console.error('FATAL: ALCHEMY_WSS_URL not set');
  process.exit(1);
}

// ── Stats ────────────────────────────────────────────────────────────────────
let blocksScanned    = 0;
let opportunities    = 0;
let skipped          = 0;
let rpcErrors        = 0;
const START_TIME     = Date.now();

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('─'.repeat(60));
  console.log('  Apex Predator — cbETH Fair Value Dry-Run');
  console.log('─'.repeat(60));
  console.log(`  BOT_ID:      ${BOT_ID}`);
  console.log(`  STRATEGY_ID: ${STRATEGY_ID}`);
  console.log(`  RUN_ID:      ${RUN_ID}`);
  console.log(`  MODE:        DRY RUN — no transactions will be sent`);
  console.log(`  CHAIN:       Base (8453)`);
  console.log(`  THRESHOLD:   ${MIN_NET_EDGE_BPS}bps net`);
  console.log('─'.repeat(60));

  await initTelegram();

  const provider = await createWsProvider(WSS_URL);
  const engine   = new CbEthFairValueEngine(provider, {
    minNetEdgeBps:   MIN_NET_EDGE_BPS,
    safetyBufferBps: 10,
    revertRiskBps:   5,
    slippageBps:     5,
    botId:           BOT_ID,
    strategyId:      STRATEGY_ID,
  });

  console.log('[RUN] Connected to Base. Scanning every block...\n');

  provider.on('block', async (blockNum: number) => {
    blocksScanned++;

    const signal = await engine.scan(provider);

    if (!signal) {
      rpcErrors++;
      return;
    }

    // Attach run identity to log record
    const record = {
      ...signal,
      bot_id:      BOT_ID,
      strategy_id: STRATEGY_ID,
      run_id:      RUN_ID,
      // Force safety flags in every log row — no ambiguity
      dry_run:     true,
      allow_live:  false,
    };

    // Always write to JSONL
    logCbEthSignal(record);

    if (signal.opportunity) {
      opportunities++;
      console.log(
        `[OPPORTUNITY] block=${blockNum} grossEdge=${signal.grossEdgeBps.toFixed(2)}bps ` +
        `netEdge=${signal.netEdgeBps.toFixed(2)}bps hash=${signal.opportunityHash} [DRY RUN — not executed]`
      );
      sendAlert(
        `cbETH opportunity detected\nNet edge: ${signal.netEdgeBps.toFixed(2)}bps\nBlock: ${blockNum}\nHash: ${signal.opportunityHash}\n[DRY RUN]`,
        'profit'
      );
    } else {
      skipped++;
      if (blocksScanned % 50 === 0) {
        const elapsed = Math.floor((Date.now() - START_TIME) / 1000);
        console.log(
          `[SCAN] blocks=${blocksScanned} opps=${opportunities} ` +
          `rpcErrors=${rpcErrors} uptime=${elapsed}s | ` +
          `lastEdge=${signal.grossEdgeBps.toFixed(2)}bps gross / ${signal.netEdgeBps.toFixed(2)}bps net`
        );
      }
    }
  });

  // Hourly summary log
  setInterval(() => {
    const elapsed = Math.floor((Date.now() - START_TIME) / 60_000);
    console.log(
      `\n[HOURLY] uptime=${elapsed}min blocks=${blocksScanned} ` +
      `opportunities=${opportunities} rpcErrors=${rpcErrors}\n`
    );
    sendAlert(
      `Hourly summary — ${elapsed}min uptime\nBlocks: ${blocksScanned}\nOpportunities: ${opportunities}\nRPC errors: ${rpcErrors}`,
      'alert'
    );
  }, 60 * 60 * 1000);
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
