import WebSocket from 'ws';
import { logger } from '../core/logger';

export interface CexPrice {
  symbol:      string;
  bid:         number;
  ask:         number;
  mid:         number;
  updatedAtMs: number;
}

const STALE_MS = 5_000;

class BinanceFeed {
  private prices = new Map<string, CexPrice>();
  private ws:     WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly symbols: string[]) {}

  start(): void {
    this.connect();
  }

  private connect(): void {
    const streams = this.symbols.map(s => `${s}@bookTicker`).join('/');
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      logger.info('CEX', `Binance feed connected (${this.symbols.join(', ')})`);
    });

    this.ws.on('message', (raw: Buffer) => {
      try {
        const msg  = JSON.parse(raw.toString());
        const data = msg.data ?? msg;
        const sym  = (data.s as string).toLowerCase().replace('usdt', 'usdc');
        this.prices.set(sym, {
          symbol:      sym,
          bid:         parseFloat(data.b),
          ask:         parseFloat(data.a),
          mid:         (parseFloat(data.b) + parseFloat(data.a)) / 2,
          updatedAtMs: Date.now(),
        });
      } catch { /* ignore parse errors */ }
    });

    this.ws.on('close', () => {
      logger.warn('CEX', 'Binance disconnected — reconnecting in 3s');
      this.reconnectTimer = setTimeout(() => this.connect(), 3_000);
    });

    this.ws.on('error', (err) => {
      logger.error('CEX', `Binance WebSocket error: ${err.message}`);
    });
  }

  getMid(symbol: string): number | null {
    const p = this.prices.get(symbol.toLowerCase());
    if (!p) return null;
    if (Date.now() - p.updatedAtMs > STALE_MS) return null;
    return p.mid;
  }

  getDivergenceBps(symbol: string, dexPrice: number): number | null {
    const mid = this.getMid(symbol);
    if (mid === null || mid === 0) return null;
    return ((dexPrice - mid) / mid) * 10_000;
  }

  isStale(symbol: string): boolean {
    const p = this.prices.get(symbol.toLowerCase());
    return !p || Date.now() - p.updatedAtMs > STALE_MS;
  }

  getAll(): Map<string, CexPrice> {
    return this.prices;
  }

  destroy(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.terminate();
  }
}

let _feed: BinanceFeed | null = null;

export function getCexFeed(): BinanceFeed {
  if (!_feed) {
    _feed = new BinanceFeed(['ethusdc', 'btcusdc']);
    _feed.start();
  }
  return _feed;
}

export function destroyCexFeed(): void {
  _feed?.destroy();
  _feed = null;
}
