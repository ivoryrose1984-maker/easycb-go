// src/infrastructure/wsProvider.ts
import { ethers } from 'ethers';
import CONFIG from '../config/constants';

interface ReconnectConfig {
  baseDelay:          number;
  maxDelay:           number;
  maxAttempts:        number;
  keepaliveInterval:  number;
}

class ManagedWebSocketProvider {
  private provider:          ethers.WebSocketProvider | null = null;
  private reconnectAttempts  = 0;
  private reconnecting       = false;
  private keepaliveTimer:    NodeJS.Timeout | null = null;
  private readonly url:      string;
  private readonly cfg:      ReconnectConfig;
  private readyPromise:      Promise<ethers.WebSocketProvider>;
  private readyResolve!:     (p: ethers.WebSocketProvider) => void;
  private readyReject!:      (e: Error) => void;

  constructor(url: string, cfg: Partial<ReconnectConfig> = {}) {
    this.url = url;
    this.cfg = {
      baseDelay:         cfg.baseDelay         ?? CONFIG.WSS_BASE_DELAY_MS,
      maxDelay:          cfg.maxDelay          ?? CONFIG.WSS_MAX_DELAY_MS,
      maxAttempts:       cfg.maxAttempts       ?? CONFIG.WSS_MAX_ATTEMPTS,
      keepaliveInterval: cfg.keepaliveInterval ?? CONFIG.WSS_KEEPALIVE_MS,
    };
    this.readyPromise = new Promise((res, rej) => {
      this.readyResolve = res;
      this.readyReject  = rej;
    });
    this.connect();
  }

  private async connect(): Promise<void> {
    try {
      this.reconnectAttempts++;
      console.log(`[WSS] Connecting (attempt ${this.reconnectAttempts}/${this.cfg.maxAttempts})...`);

      if (this.provider) {
        try { await this.provider.destroy(); } catch { /* ignore */ }
      }
      if (this.keepaliveTimer) {
        clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = null;
      }

      this.provider = new ethers.WebSocketProvider(this.url);

      // Use the public network-change event instead of private _websocket
      this.provider.on('network', (_newNet, oldNet) => {
        if (oldNet) {
          console.warn('[WSS] Network changed unexpectedly — reconnecting');
          this.handleDisconnect();
        }
      });

      // Poll once to verify connectivity before declaring ready
      const blockNumber = await this.provider.getBlockNumber();
      console.log(`[WSS] ✅ Connected (block ${blockNumber})`);

      this.reconnectAttempts = 0;
      this.reconnecting      = false;
      this.startKeepalive();
      this.readyResolve(this.provider);

    } catch (error) {
      console.error('[WSS] Connection failed:', error);
      await this.scheduleReconnect();
    }
  }

  private handleDisconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;
    console.log('[WSS] Disconnected — scheduling reconnect...');
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.scheduleReconnect();
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.cfg.maxAttempts) {
      const err = new Error(`[WSS] Failed after ${this.cfg.maxAttempts} attempts.`);
      console.error(err.message);
      this.readyReject(err);
      setTimeout(() => process.exit(1), 5000);
      return;
    }
    const delay = Math.min(
      this.cfg.baseDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.cfg.maxDelay
    );
    console.log(`[WSS] Retrying in ${delay}ms...`);
    await new Promise(r => setTimeout(r, delay));
    await this.connect();
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(async () => {
      if (!this.provider) return;
      try {
        await this.provider.getBlockNumber();
      } catch {
        console.warn('[WSS] Keepalive ping failed — reconnecting');
        this.handleDisconnect();
      }
    }, this.cfg.keepaliveInterval);
  }

  async waitUntilReady(): Promise<ethers.WebSocketProvider> { return this.readyPromise; }

  async destroy(): Promise<void> {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    if (this.provider) {
      try { await this.provider.destroy(); } catch { /* ignore */ }
    }
  }
}

export async function createWsProvider(url: string): Promise<ethers.WebSocketProvider> {
  const managed = new ManagedWebSocketProvider(url);
  return managed.waitUntilReady();
}

export default ManagedWebSocketProvider;
