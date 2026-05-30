import * as fs   from 'fs';
import * as path from 'path';
import CONFIG from '../core/config';
import { logger } from '../core/logger';

const LOCK_DIR  = path.resolve(process.cwd(), '.locks');
const LOCK_FILE = path.join(LOCK_DIR, `chain-${CONFIG.CHAIN_ID}.lock`);
const LOCK_TTL  = 30_000;

export function acquireLock(): boolean {
  try {
    if (!fs.existsSync(LOCK_DIR)) fs.mkdirSync(LOCK_DIR, { recursive: true });

    if (fs.existsSync(LOCK_FILE)) {
      const content = fs.readFileSync(LOCK_FILE, 'utf8');
      const { pid, ts } = JSON.parse(content) as { pid: number; ts: number };

      if (Date.now() - ts < LOCK_TTL) {
        try {
          process.kill(pid, 0);
          logger.warn('MUTEX', `Chain ${CONFIG.CHAIN_ID} locked by PID ${pid}`);
          return false;
        } catch {
          // Process dead — stale lock
        }
      }
    }

    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, ts: Date.now(), runId: CONFIG.RUN_ID }), 'utf8');
    logger.info('MUTEX', `Acquired lock for chain ${CONFIG.CHAIN_ID}`);

    const refresh = setInterval(() => {
      try {
        fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, ts: Date.now(), runId: CONFIG.RUN_ID }), 'utf8');
      } catch { /* ignore */ }
    }, LOCK_TTL / 2);

    process.on('exit', () => {
      clearInterval(refresh);
      try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
    });

    return true;
  } catch (err: any) {
    logger.error('MUTEX', `Lock failed: ${err.message}`);
    return false;
  }
}

export function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const content = fs.readFileSync(LOCK_FILE, 'utf8');
      const { pid } = JSON.parse(content) as { pid: number };
      if (pid === process.pid) {
        fs.unlinkSync(LOCK_FILE);
        logger.info('MUTEX', 'Lock released');
      }
    }
  } catch { /* ignore */ }
}
