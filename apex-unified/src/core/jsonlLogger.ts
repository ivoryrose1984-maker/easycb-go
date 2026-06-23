import * as fs   from 'fs';
import * as path from 'path';
import { Opportunity } from '../types/Opportunity';

const LOG_DIR = path.resolve(process.cwd(), 'logs');

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureDir(): void {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

export function appendJsonl(prefix: string, record: Record<string, unknown>): void {
  try {
    ensureDir();
    fs.appendFileSync(
      path.join(LOG_DIR, `${prefix}-${today()}.jsonl`),
      JSON.stringify(record) + '\n',
      'utf8'
    );
  } catch (err) {
    console.error('[JSONL] Write failed:', err);
  }
}

export function logOpportunity(opp: Opportunity): void {
  appendJsonl('unified-opportunities', opp as unknown as Record<string, unknown>);
}

export function logSignal(strategyId: string, record: Record<string, unknown>): void {
  appendJsonl(`unified-signals-${strategyId.replace('.', '-')}`, record);
}

export function logRejection(record: Record<string, unknown>): void {
  appendJsonl('unified-rejections', record);
}

export function logSummary(record: Record<string, unknown>): void {
  appendJsonl('unified-summary', record);
}

export function logError(record: Record<string, unknown>): void {
  appendJsonl('unified-errors', record);
}

export function readLog(prefix: string, date?: string): Opportunity[] {
  const d = date ?? today();
  const filepath = path.join(LOG_DIR, `${prefix}-${d}.jsonl`);
  if (!fs.existsSync(filepath)) return [];
  return fs.readFileSync(filepath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Opportunity);
}

export function readOpportunities(date?: string): Opportunity[] {
  return readLog('unified-opportunities', date);
}
