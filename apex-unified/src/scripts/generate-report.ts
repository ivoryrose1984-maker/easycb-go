import { generate72HourReport } from '../research/reportGenerator';
import { logger } from '../core/logger';

async function main(): Promise<void> {
  logger.info('REPORT', 'Generating 72-hour dry-run report...');
  const report = await generate72HourReport();

  console.log('\n' + '═'.repeat(65));
  console.log('  APEX UNIFIED — 72-HOUR DRY-RUN REPORT');
  console.log('═'.repeat(65));
  console.log(`  Run ID:      ${report.runId}`);
  console.log(`  Period:      ${new Date(report.periodStartMs).toISOString()} → ${new Date(report.periodEndMs).toISOString()}`);
  console.log(`  Generated:   ${report.generatedAt}`);
  console.log('');

  for (const s of report.strategies) {
    console.log(`  ── Strategy: ${s.strategyId}`);
    console.log(`     Scans:        ${s.totalScans}`);
    console.log(`     Accepted:     ${s.acceptedOpportunities}`);
    console.log(`     Rejected:     ${s.rejectedOpportunities}`);
    console.log(`     Gross P&L:    $${s.grossEstimatedProfitUsd.toFixed(2)}`);
    console.log(`     Net P&L:      $${s.netEstimatedProfitUsd.toFixed(2)}`);
    console.log(`     Median bps:   ${s.medianOpportunityBps}`);
    console.log(`     False pos:    ${(s.falsePositiveRate * 100).toFixed(1)}%`);
    console.log('');
  }

  console.log(`  Best strategy:     ${report.bestStrategyId ?? 'none'}`);
  console.log(`  Live readiness:    ${report.liveReadinessScore}/100`);

  if (report.blockers.length > 0) {
    console.log('\n  Blockers before live execution:');
    for (const b of report.blockers) {
      console.log(`    ✗ ${b}`);
    }
  } else {
    console.log('\n  No blockers — system may be ready for live review');
  }

  console.log('\n  ' + report.summary);
  console.log('═'.repeat(65));
  logger.info('REPORT', `Saved to logs/report-${report.runId.slice(0, 8)}.json`);
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
