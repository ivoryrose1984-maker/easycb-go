import { replayDate }       from '../research/replayEngine';
import { backtest }         from '../research/backtester';
import { optimizeThreshold } from '../research/parameterOptimizer';
import { logger }           from '../core/logger';

async function main(): Promise<void> {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  logger.info('REPLAY', `Replaying ${date}...`);

  const session = await replayDate(date);
  if (session.opportunities.length === 0) {
    console.log(`No opportunities found for ${date}`);
    return;
  }

  console.log(`\n  Date: ${date}  |  Total opportunities: ${session.opportunities.length}\n`);

  for (const [strategyId, opps] of session.byStrategy) {
    const bt  = backtest(opps);
    const opt = optimizeThreshold(opps);

    console.log(`  ── ${strategyId}`);
    console.log(`     Count:       ${opps.length}`);
    console.log(`     Executed:    ${bt.executed}`);
    console.log(`     Gross USD:   $${bt.totalGrossUsd.toFixed(2)}`);
    console.log(`     Net USD:     $${bt.totalNetUsd.toFixed(2)}`);
    console.log(`     Win rate:    ${(bt.winRate * 100).toFixed(1)}%`);
    console.log(`     Avg bps:     ${bt.avgEdgeBps.toFixed(2)}`);
    console.log(`     Best thresh: ${opt.bestMinBps}bps (net $${opt.bestNetUsd.toFixed(2)})`);
    console.log('');
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
