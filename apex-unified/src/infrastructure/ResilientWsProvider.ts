import { WebSocketProvider } from 'ethers';
import { logger } from '../core/logger';
import { rpcHealth, setCachedBlock } from '../core/rpcHealth';

type ListenerEntry  = { event: string; handler: (...args: any[]) => void };
type ConnectHandler = (provider: WebSocketProvider) => void | Promise<void>;

const BASE_BLOCK_TIME_MS = 2_000;

export class ResilientWsProvider {
  public provider!: WebSocketProvider;

  private url: string;
  private chainId: number;
  private listeners:      ListenerEntry[]  = [];
  private connectHandlers: ConnectHandler[] = [];

  private attempt              = 0;
  private consecutiveFailures  = 0;
  private reconnecting         = false;

  private static readonly BASE_DELAY_MS             = 1_000;
  private static readonly MAX_DELAY_MS              = 60_000;
  private static readonly RATE_LIMIT_FLOOR_MS       = 10_000;
  private static readonly MAX_CONSECUTIVE_FAILURES  = 20;

  private lastBlockAt   = Date.now();
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly WATCHDOG_TIMEOUT_MS = 30_000;

  constructor(url: string, chainId: number) {
    this.url     = url;
    this.chainId = chainId;
  }

  /** Called immediately after every successful connect (initial + reconnects). */
  onConnect(handler: ConnectHandler): void {
    this.connectHandlers.push(handler);
  }

  on(event: string, handler: (...args: any[]) => void): void {
    this.listeners.push({ event, handler });
    if (this.provider) {
      this.provider.on(event, this.wrap(event, handler));
    }
  }

  async start(): Promise<void> {
    await this.connect();
    this.startWatchdog();
  }

  // ── Core connect / reconnect ──────────────────────────────────────────

  private async connect(): Promise<void> {
    this.provider = new WebSocketProvider(this.url, this.chainId);

    const ws: any = (this.provider as any).websocket;

    ws?.on?.('close', (code: number) => {
      // If the unhandledRejection handler already detected a rate-limit on this
      // connection (e.g. eth_subscribe rejected with code 15), honour the floor.
      const isRateLimit = rpcHealth.getState() === 'THROTTLED';
      logger.warn('RWS', `Socket closed (code=${code})${isRateLimit ? ' — rate-limited' : ''}`);
      this.scheduleReconnect(isRateLimit);
    });

    ws?.on?.('error', (err: any) => {
      const msg   = String(err?.message ?? err);
      const is429 = msg.includes('429');
      logger.error('RWS', `Socket error: ${msg}`);
      this.scheduleReconnect(is429);
    });

    for (const { event, handler } of this.listeners) {
      this.provider.on(event, this.wrap(event, handler));
    }

    const block = await this.provider.getBlockNumber();
    this.lastBlockAt         = Date.now();
    this.attempt             = 0;
    this.consecutiveFailures = 0;
    rpcHealth.markSuccess(); // successful connect = one positive health signal
    logger.info('RWS', `Connected — head block ${block}`);

    for (const h of this.connectHandlers) {
      try { await h(this.provider); } catch (e: any) {
        logger.error('RWS', `onConnect hook error: ${e.message}`);
      }
    }
  }

  private wrap(event: string, handler: (...args: any[]) => void) {
    if (event === 'block') {
      return (...args: any[]) => {
        this.lastBlockAt = Date.now();
        if (typeof args[0] === 'number') setCachedBlock(args[0]);
        rpcHealth.markSuccess();
        handler(...args);
      };
    }
    return handler;
  }

  private scheduleReconnect(isRateLimit: boolean): void {
    if (this.reconnecting) return;
    this.reconnecting = true;

    this.attempt++;
    this.consecutiveFailures++;

    if (isRateLimit) rpcHealth.mark429();

    if (this.consecutiveFailures >= ResilientWsProvider.MAX_CONSECUTIVE_FAILURES) {
      logger.error('RWS', `${this.consecutiveFailures} consecutive failures — exiting for PM2 restart`);
      process.exit(1);
    }

    const expCap = Math.min(
      ResilientWsProvider.MAX_DELAY_MS,
      ResilientWsProvider.BASE_DELAY_MS * 2 ** this.attempt,
    );
    let delay = Math.floor(Math.random() * expCap);
    if (isRateLimit) delay = Math.max(delay, ResilientWsProvider.RATE_LIMIT_FLOOR_MS);

    logger.warn('RWS',
      `Reconnect attempt ${this.attempt} in ${(delay / 1000).toFixed(1)}s` +
      (isRateLimit ? ' (rate-limited)' : ''),
    );

    setTimeout(async () => {
      try {
        await this.destroyCurrent();
        await this.connect();
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        logger.error('RWS', `Reconnect failed: ${msg}`);
        this.reconnecting = false;
        this.scheduleReconnect(msg.includes('429'));
        return;
      }
      this.reconnecting = false;
    }, delay);
  }

  private async destroyCurrent(): Promise<void> {
    try {
      this.provider?.removeAllListeners();
      await this.provider?.destroy();
    } catch { /* already dead */ }
  }

  async destroy(): Promise<void> {
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
    await this.destroyCurrent();
  }

  // ── Watchdog — catches silent zombie sockets ──────────────────────────────────

  private startWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      const silentFor = Date.now() - this.lastBlockAt;
      if (silentFor > ResilientWsProvider.WATCHDOG_TIMEOUT_MS && !this.reconnecting) {
        logger.warn('RWS',
          `Watchdog: no block for ${(silentFor / 1000).toFixed(0)}s ` +
          `(expected every ~${BASE_BLOCK_TIME_MS / 1000}s) — forcing reconnect`,
        );
        this.scheduleReconnect(false);
      }
    }, 5_000);
    (this.watchdogTimer as any).unref?.();
  }
}
