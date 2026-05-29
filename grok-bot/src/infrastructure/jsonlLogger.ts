import * as fs   from 'fs';
import * as path from 'path';

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

export const log = {
  signal:      (r: Record<string, unknown>) => appendJsonl('grok-signals',      r),
  opportunity: (r: Record<string, unknown>) => appendJsonl('grok-opportunities', r),
  error:       (r: Record<string, unknown>) => appendJsonl('grok-errors',        r),
  summary:     (r: Record<string, unknown>) => appendJsonl('grok-summary',       r),
};
