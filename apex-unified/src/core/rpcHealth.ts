import { logger } from './logger';

export type RpcState = 'HEALTHY' | 'DEGRADED' | 'THROTTLED';

const THROTTLE_PAUSE_MS = 60_000;  // pause non-critical scans 60s on 429
const AUTO_RESET_MS     = 90_000;  // auto-recover after 90s quiet period

class RpcHealthMonitor {
  private state:         RpcState = 'HEALTHY';
  private throttledAt    = 0;
  private consecutiveOk  = 0;
  private resetTimer:    ReturnType<typeof setTimeout> | null = null;

  getState(): RpcState { return this.state; }

  /** Returns true when RPC is rate-limited and non-critical calls should be deferred. */
  shouldSkipNonCritical(): boolean {
    if (this.state !== 'THROTTLED') return false;
    return Date.now() - this.throttledAt < THROTTLE_PAUSE_MS;
  }

  mark429(): void {
    this.consecutiveOk = 0;
    this.throttledAt   = Date.now();
    this.transition('THROTTLED');
    this.scheduleAutoReset();
    logger.warn('RPC_HEALTH',
      `Rate-limit (code 15 / 429) — non-critical scans paused ${THROTTLE_PAUSE_MS / 1_000}s; ` +
      `RWS will back off ≥15s before reconnect`
    );
  }

  markError(): void {
    this.consecutiveOk = 0;
    if (this.state === 'HEALTHY') this.transition('DEGRADED');
  }

  markSuccess(): void {
    this.consecutiveOk++;
    if (this.consecutiveOk >= 5 && this.state !== 'HEALTHY') {
      this.consecutiveOk = 0;
      this.transition('HEALTHY');
    }
  }

  private transition(to: RpcState): void {
    if (this.state !== to) {
      logger.info('RPC_HEALTH', `State: ${this.state} → ${to}`);
      this.state = to;
    }
  }

  private scheduleAutoReset(): void {
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = setTimeout(() => {
      this.resetTimer    = null;
      this.consecutiveOk = 0;
      this.transition('HEALTHY');
      logger.info('RPC_HEALTH', 'Auto-reset to HEALTHY after quiet period');
    }, AUTO_RESET_MS);
    (this.resetTimer as any)?.unref?.();
  }
}

export const rpcHealth = new RpcHealthMonitor();

// ── Global block number cache ─────────────────────────────────────────────────
// Set on every block event; lets any module read the current head without
// issuing an extra eth_blockNumber call.
let _cachedBlock   = 0;
let _cachedBlockAt = 0;

export function setCachedBlock(n: number): void {
  _cachedBlock   = n;
  _cachedBlockAt = Date.now();
}

export function getCachedBlock(): number { return _cachedBlock; }
