#!/usr/bin/env node
/**
 * Dry-run opportunity analyzer.
 *
 * Usage:
 *   npx ts-node src/scripts/analyze-opportunities.ts [path]
 *
 * [path] can be:
 *   - a JSONL file:       logs/unified-opportunities-2024-01-15.jsonl
 *   - a directory:        logs/   (scans all unified-opportunities-*.jsonl files)
 *   - a PM2 text log:     ~/night1.log
 *   - omitted:            defaults to ./logs/ directory
 *
 * Environment overrides:
 *   SUSPICIOUS_BPS=300    spreads above this are flagged as likely stale/artifact
 *   HIGH_VALUE_USD=50     flag individual opps above this USD gross in the detail list
 */

import * as fs   from 'fs';
import * as path from 'path';

const SUSPICIOUS_BPS = parseInt(process.env.SUSPICIOUS_BPS ?? '300', 10);
const HIGH_VALUE_USD = parseFloat(process.env.HIGH_VALUE_USD ?? '50');

interface ParsedOpp {
  strategyId: string;
  route:      string;
  spreadBps:  number;
  grossUsd:   number;
  netUsd:     number;
  block:      number;
  ts:         Date | null;
  hash:       string;
}

// ── Parsers ───────────────────────────────────────────────────────────────────

function parseJsonlFile(filePath: string): ParsedOpp[] {
  const opps: ParsedOpp[] = [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (!o.strategyId || o.spreadBps === undefined) continue;
      opps.push({
        strategyId: o.strategyId,
        route:      o.route ?? o.strategyId,
        spreadBps:  Number(o.spreadBps),
        grossUsd:   Number(o.grossProfitUsd ?? 0),
        netUsd:     Number(o.netProfitUsd   ?? 0),
        block:      Number(o.blockNumber    ?? 0),
        ts:         o.timestamp ? new Date(o.timestamp) : null,
        hash:       o.opportunityHash ?? '',
      });
    } catch { /* skip malformed lines */ }
  }
  return opps;
}

/** Parse the plain-text PM2 log format produced by `pm2 logs --nostream`. */
function parsePm2Log(filePath: string): ParsedOpp[] {
  // Log line: [HH:MM:SS.mmm][DRY_RUN] [OPPORTUNITY] strat=X hash=Y spread=Zbps gross=$W block=N
  // PM2 prefix (optional): "0|apex-uni  | " before the logger output
  const OPP_RE = /\[OPPORTUNITY\]\s+strat=(\S+)\s+hash=(\S+)\s+spread=(\d+(?:\.\d+)?)bps\s+gross=\$(\d+(?:\.\d+)?)\s+block=(\d+)/;
  const TS_RE  = /\[(\d{2}:\d{2}:\d{2}\.\d+)\]/;

  const fileStat  = fs.statSync(filePath);
  const fileDate  = fileStat.mtime.toISOString().slice(0, 10);
  const content   = fs.readFileSync(filePath, 'utf8');
  const opps: ParsedOpp[] = [];

  for (const line of content.split('\n')) {
    const m = line.match(OPP_RE);
    if (!m) continue;
    const [, strat, hash, spreadStr, grossStr, blockStr] = m;
    const tsMatch = line.match(TS_RE);
    let ts: Date | null = null;
    if (tsMatch) {
      try { ts = new Date(`${fileDate}T${tsMatch[1]}Z`); } catch { /* ignore */ }
    }
    opps.push({
      strategyId: strat,
      route:      '(route unavailable — use JSONL for pair detail)',
      spreadBps:  parseFloat(spreadStr),
      grossUsd:   parseFloat(grossStr),
      netUsd:     0,
      block:      parseInt(blockStr, 10),
      ts,
      hash,
    });
  }
  return opps;
}

function loadOpportunities(target: string): ParsedOpp[] {
  const stat = fs.statSync(target);

  if (stat.isDirectory()) {
    const files = fs.readdirSync(target)
      .filter(f => f.startsWith('unified-opportunities-') && f.endsWith('.jsonl'))
      .map(f => path.join(target, f))
      .sort();
    if (files.length === 0) {
      console.error(`No unified-opportunities-*.jsonl files found in ${target}`);
      process.exit(1);
    }
    console.log(`Found ${files.length} JSONL file(s): ${files.map(f => path.basename(f)).join(', ')}\n`);
    return files.flatMap(parseJsonlFile);
  }

  if (target.endsWith('.jsonl')) return parseJsonlFile(target);
  return parsePm2Log(target);
}

// ── Statistics helpers ────────────────────────────────────────────────────────

function median(vals: number[]): number {
  if (vals.length === 0) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(vals: number[]): number {
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

function pct(n: number, total: number): string {
  return total ? `${((n / total) * 100).toFixed(1)}%` : '0%';
}

const BUCKETS: { label: string; min: number; max: number }[] = [
  { label: '  0 – 20 bps  ', min: 0,   max: 20   },
  { label: ' 20 – 50 bps  ', min: 20,  max: 50   },
  { label: ' 50 – 100 bps ', min: 50,  max: 100  },
  { label: '100 – 300 bps ', min: 100, max: 300  },
  { label: '300 – 500 bps ', min: 300, max: 500  },
  { label: '500+ bps      ', min: 500, max: Infinity },
];

// ── Report ────────────────────────────────────────────────────────────────────

function report(opps: ParsedOpp[]): void {
  if (opps.length === 0) {
    console.log('No opportunities found in the provided log.');
    return;
  }

  const plausible   = opps.filter(o => o.spreadBps < SUSPICIOUS_BPS);
  const suspicious  = opps.filter(o => o.spreadBps >= SUSPICIOUS_BPS);

  // Time range
  const timestamps  = opps.map(o => o.ts).filter((t): t is Date => t !== null);
  const earliest    = timestamps.length ? new Date(Math.min(...timestamps.map(t => t.getTime()))) : null;
  const latest      = timestamps.length ? new Date(Math.max(...timestamps.map(t => t.getTime()))) : null;
  const spanHours   = earliest && latest
    ? (latest.getTime() - earliest.getTime()) / 3_600_000
    : null;
  const ratePerHour = spanHours && spanHours > 0
    ? (opps.length / spanHours).toFixed(1)
    : 'N/A';
  const plausibleRatePerHour = spanHours && spanHours > 0
    ? (plausible.length / spanHours).toFixed(1)
    : 'N/A';

  // By strategy
  const byStrategy = new Map<string, ParsedOpp[]>();
  for (const o of opps) {
    if (!byStrategy.has(o.strategyId)) byStrategy.set(o.strategyId, []);
    byStrategy.get(o.strategyId)!.push(o);
  }

  // By route (top 15)
  const byRoute = new Map<string, ParsedOpp[]>();
  for (const o of opps) {
    const key = o.route.split(' (')[0].trim(); // strip execution detail
    if (!byRoute.has(key)) byRoute.set(key, []);
    byRoute.get(key)!.push(o);
  }
  const topRoutes = [...byRoute.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 15);

  const sep = '═'.repeat(65);
  const thin = '─'.repeat(65);

  console.log(`\n${sep}`);
  console.log('  APEX UNIFIED — DRY-RUN OPPORTUNITY ANALYSIS');
  console.log(`${sep}`);

  // Time span
  if (earliest && latest) {
    console.log(`\nLog span:   ${earliest.toISOString()} → ${latest.toISOString()}`);
    console.log(`            (${spanHours!.toFixed(1)} hours)`);
  }
  console.log(`Input type: ${opps[0]?.route.includes('unavailable') ? 'PM2 text log' : 'JSONL'}`);

  // ── Totals ──────────────────────────────────────────────────────────────────
  console.log(`\n${thin}`);
  console.log('  TOTALS');
  console.log(thin);
  console.log(`  Total opportunities logged:   ${opps.length}`);
  console.log(`  Plausible  (< ${SUSPICIOUS_BPS}bps):        ${plausible.length.toString().padStart(5)}  (${pct(plausible.length, opps.length)})`);
  console.log(`  Suspicious (≥ ${SUSPICIOUS_BPS}bps):        ${suspicious.length.toString().padStart(5)}  (${pct(suspicious.length, opps.length)})`);
  console.log(`  Rate (all):          ${ratePerHour} opps/hr`);
  console.log(`  Rate (plausible):    ${plausibleRatePerHour} opps/hr`);

  // ── By strategy ─────────────────────────────────────────────────────────────
  console.log(`\n${thin}`);
  console.log('  BY STRATEGY');
  console.log(thin);
  for (const [strat, items] of [...byStrategy.entries()].sort()) {
    const p = items.filter(o => o.spreadBps < SUSPICIOUS_BPS);
    const s = items.filter(o => o.spreadBps >= SUSPICIOUS_BPS);
    const grossArr = p.map(o => o.grossUsd);
    console.log(`  ${strat.padEnd(28)} ${items.length.toString().padStart(4)} total`
      + `  (plausible=${p.length} suspicious=${s.length})`
      + (grossArr.length ? `  median=$${median(grossArr).toFixed(2)}` : '')
    );
  }

  // ── Spread buckets ───────────────────────────────────────────────────────────
  console.log(`\n${thin}`);
  console.log('  SPREAD DISTRIBUTION (all opportunities)');
  console.log(thin);
  for (const bucket of BUCKETS) {
    const items = opps.filter(o => o.spreadBps >= bucket.min && o.spreadBps < bucket.max);
    const bar   = '█'.repeat(Math.min(40, Math.round((items.length / opps.length) * 40)));
    const flag  = bucket.min >= SUSPICIOUS_BPS ? ' ⚠ SUSPICIOUS' : '';
    console.log(`  ${bucket.label}  ${items.length.toString().padStart(4)}  ${bar}${flag}`);
  }

  // ── By route ────────────────────────────────────────────────────────────────
  if (!opps[0]?.route.includes('unavailable')) {
    console.log(`\n${thin}`);
    console.log('  TOP ROUTES  (plausible only, sorted by count)');
    console.log(thin);
    const plausibleByRoute = [...byRoute.entries()]
      .map(([k, v]) => [k, v.filter(o => o.spreadBps < SUSPICIOUS_BPS)] as [string, ParsedOpp[]])
      .filter(([, v]) => v.length > 0)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 15);
    for (const [route, items] of plausibleByRoute) {
      const grossArr = items.map(o => o.grossUsd);
      const maxSpread = Math.max(...items.map(o => o.spreadBps));
      console.log(
        `  ${route.slice(0, 38).padEnd(38)}`
        + `  ${items.length.toString().padStart(3)} opps`
        + `  med=$${median(grossArr).toFixed(2).padStart(7)}`
        + `  max=${maxSpread.toFixed(0)}bps`
      );
    }
  }

  // ── Suspicious deep-dive ─────────────────────────────────────────────────────
  if (suspicious.length > 0) {
    console.log(`\n${thin}`);
    console.log(`  ⚠  SUSPICIOUS OPPORTUNITIES (≥ ${SUSPICIOUS_BPS}bps) — LIKELY STALE/ARTIFACT`);
    console.log(thin);
    const susByStrat = new Map<string, number>();
    const susByRoute = new Map<string, { count: number; maxBps: number; maxUsd: number }>();
    for (const o of suspicious) {
      susByStrat.set(o.strategyId, (susByStrat.get(o.strategyId) ?? 0) + 1);
      const key = o.route.split(' (')[0].trim();
      const cur = susByRoute.get(key) ?? { count: 0, maxBps: 0, maxUsd: 0 };
      susByRoute.set(key, { count: cur.count + 1, maxBps: Math.max(cur.maxBps, o.spreadBps), maxUsd: Math.max(cur.maxUsd, o.grossUsd) });
    }
    console.log('  By strategy:');
    for (const [s, n] of susByStrat) console.log(`    ${s.padEnd(30)} ${n} occurrences`);
    if (!opps[0]?.route.includes('unavailable')) {
      console.log('  By route:');
      for (const [r, d] of [...susByRoute.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 10)) {
        console.log(`    ${r.slice(0, 38).padEnd(38)}  ${d.count}x  max=${d.maxBps.toFixed(0)}bps  max=$${d.maxUsd.toFixed(2)}`);
      }
    }
    const suspGrossArr = suspicious.map(o => o.grossUsd);
    console.log(`\n  Suspicious median gross: $${median(suspGrossArr).toFixed(2)}`);
    console.log(`  Suspicious mean gross:   $${mean(suspGrossArr).toFixed(2)}`);
    console.log(`  Note: these will NOT execute even if live — real fills would revert.`);
  }

  // ── Plausible financials ─────────────────────────────────────────────────────
  console.log(`\n${thin}`);
  console.log('  PLAUSIBLE OPPORTUNITY FINANCIALS');
  console.log(thin);
  if (plausible.length === 0) {
    console.log('  No plausible opportunities found.');
  } else {
    const gross   = plausible.map(o => o.grossUsd);
    const net     = plausible.map(o => o.netUsd).filter(v => v > 0);
    const topOpps = plausible
      .filter(o => o.grossUsd >= HIGH_VALUE_USD)
      .sort((a, b) => b.grossUsd - a.grossUsd)
      .slice(0, 10);

    console.log(`  Count:          ${plausible.length}`);
    console.log(`  Gross median:   $${median(gross).toFixed(2)}`);
    console.log(`  Gross mean:     $${mean(gross).toFixed(2)}`);
    console.log(`  Gross total:    $${gross.reduce((a, b) => a + b, 0).toFixed(2)}`);
    if (net.length > 0) {
      console.log(`  Net median:     $${median(net).toFixed(2)}`);
      console.log(`  Net total:      $${net.reduce((a, b) => a + b, 0).toFixed(2)}`);
    }
    console.log(`  Spread median:  ${median(plausible.map(o => o.spreadBps)).toFixed(1)} bps`);
    console.log(`  Spread mean:    ${mean(plausible.map(o => o.spreadBps)).toFixed(1)} bps`);

    if (topOpps.length > 0) {
      console.log(`\n  Top opportunities (gross ≥ $${HIGH_VALUE_USD}):`);
      for (const o of topOpps) {
        const when = o.ts ? o.ts.toISOString().slice(11, 19) : '?';
        const route = o.route.slice(0, 40).padEnd(40);
        console.log(`    [${when}] ${route}  ${o.spreadBps.toFixed(0).padStart(5)}bps  $${o.grossUsd.toFixed(2).padStart(8)}`);
      }
    }
  }

  // ── Verdict ──────────────────────────────────────────────────────────────────
  console.log(`\n${sep}`);
  console.log('  VERDICT');
  console.log(sep);
  const realPct   = plausible.length / opps.length;
  const noisePct  = suspicious.length / opps.length;
  const grossArr  = plausible.map(o => o.grossUsd);
  const medGross  = median(grossArr);

  if (opps.length < 10) {
    console.log('  ⚠  Too few opportunities to draw conclusions. Run longer.');
  } else if (noisePct > 0.5) {
    console.log(`  🔴  HIGH NOISE: ${pct(suspicious.length, opps.length)} of opps are suspicious (≥${SUSPICIOUS_BPS}bps).`);
    console.log('      This strongly suggests stale-pool artifacts or data issues.');
    console.log('      Do NOT go live until root cause is found.');
  } else if (noisePct > 0.2) {
    console.log(`  🟡  MIXED SIGNAL: ${pct(suspicious.length, opps.length)} suspicious, ${pct(plausible.length, opps.length)} plausible.`);
    console.log('      Proceed with caution. Investigate the suspicious routes.');
  } else if (medGross < 1) {
    console.log(`  🟡  MOSTLY PLAUSIBLE but median gross is $${medGross.toFixed(2)} — very thin.`);
    console.log('      Real opportunities exist but may not cover execution costs reliably.');
  } else {
    console.log(`  🟢  LOOKS REAL: ${pct(plausible.length, opps.length)} plausible, median gross $${medGross.toFixed(2)}.`);
    console.log(`      ${plausibleRatePerHour} plausible opps/hr is a reasonable signal rate for Base L2.`);
    if (medGross >= 5) {
      console.log('      Financials are strong enough to justify live readiness review.');
    } else {
      console.log('      Financials are modest — live viability depends on consistent volume.');
    }
  }
  console.log(sep + '\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────

const target = process.argv[2] ?? path.resolve(process.cwd(), 'logs');

if (!fs.existsSync(target)) {
  console.error(`Path not found: ${target}`);
  process.exit(1);
}

const opps = loadOpportunities(target);
console.log(`Parsed ${opps.length} opportunities.`);
report(opps);
