import { generate72HourReport } from '../research/reportGenerator';
import { logger } from '../core/logger';

async function main(): Promise<void> {
  logger.info('REPORT', 'Generating 72-hour dry-run report...');
  const report = await generate72HourReport();

  console.log('\n' + '═'.repeat(65));
  console.log('  APEX UNIFIED — 72-HOUR DRY-RUN REPORT');
  console.log('═'.repeat(65));
  console.log(`  Run ID:         ${report.runId}`);
  console.log(`  Period:         ${new Date(report.periodStartMs).toISOString()} → ${new Date(report.periodEndMs).toISOString()}`);
  console.log(`  Clean data since: ${report.cleanDataSince}  ← all figures exclude events before this`);
  console.log(`  Generated:      ${report.generatedAt}`);
  console.log('');

  for (const s of report.strategies) {
    const disabledTag = s.disabled ? `  [DISABLED: ${s.disabled}]` : '';
    console.log(`  ── Strategy: ${s.strategyId}${disabledTag}`);
    if (s.disabled) {
      console.log(`     (no data — strategy disabled at startup)`);
    } else {
      console.log(`     Scans:        ${s.totalScans}`);
      console.log(`     Accepted:     ${s.acceptedOpportunities}`);
      console.log(`     Rejected:     ${s.rejectedOpportunities}`);
      console.log(`     Gross P&L:    $${s.grossEstimatedProfitUsd.toFixed(2)}`);
      console.log(`     Net P&L:      $${s.netEstimatedProfitUsd.toFixed(2)}`);
      console.log(`     Median bps:   ${s.medianOpportunityBps}`);
      console.log(`     False pos:    ${(s.falsePositiveRate * 100).toFixed(1)}%`);
    }
    console.log('');
  }

  if (report.captureStats.length > 0) {
    console.log('  ── Capture Telemetry');
    console.log(`  ${'Strategy'.padEnd(28)} ${'Det'.padStart(7)} ${'Pass'.padStart(6)} ${'Skip'.padStart(6)} ${'Anom'.padStart(5)} ${'GrossUSD'.padStart(10)} ${'NetUSD'.padStart(9)} ${'MedBps'.padStart(7)}`);
    for (const c of report.captureStats) {
      console.log(
        `  ${c.strategyId.padEnd(28)} ` +
        `${String(c.detected).padStart(7)} ` +
        `${String(c.passed).padStart(6)} ` +
        `${String(c.skipped).padStart(6)} ` +
        `${String(c.anomalies).padStart(5)} ` +
        `${('$' + c.grossEstimatedProfitUsd.toFixed(2)).padStart(10)} ` +
        `${('$' + c.netEstimatedProfitUsd.toFixed(2)).padStart(9)} ` +
        `${String(c.medianSpreadBps).padStart(7)}`
      );
    }
    if (report.captureStats.some(c => Object.keys(c.skipReasonBreakdown).length > 0)) {
      console.log('');
      console.log('  ── Skip reasons');
      for (const c of report.captureStats) {
        for (const [reason, count] of Object.entries(c.skipReasonBreakdown).sort((a, b) => b[1] - a[1])) {
          console.log(`  ${c.strategyId.padEnd(28)}   ${reason.padEnd(28)} ${count}`);
        }
      }
    }
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
