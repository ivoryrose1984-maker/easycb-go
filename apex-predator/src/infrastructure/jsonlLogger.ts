import * as fs   from 'fs';
import * as path from 'path';

const LOG_DIR = path.resolve(process.cwd(), 'logs');

function todayFile(prefix: string): string {
  const d = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `${prefix}-${d}.jsonl`);
}

function ensureDir(): void {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

export function appendJsonl(prefix: string, record: Record<string, unknown>): void {
  try {
    ensureDir();
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(todayFile(prefix), line, 'utf8');
  } catch (err) {
    console.error('[JSONL] Write failed:', err);
  }
}

export function logCbEthSignal(signal: Record<string, unknown>): void {
  appendJsonl('cbeth-dry-run', signal);
}

export function logOpportunity(record: Record<string, unknown>): void {
  appendJsonl('opportunities', record);
}

export function logRejectionJsonl(record: Record<string, unknown>): void {
  appendJsonl('rejections', record);
}
