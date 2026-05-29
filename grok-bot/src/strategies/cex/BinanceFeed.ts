import WebSocket from 'ws';
import { ENV } from '../../config/env';

export interface CexPrice {
  symbol:      string;
  bid:         number;
  ask:         number;
  mid:         number;
  updatedAtMs: number;
}

// Stale threshold — reject CEX price older than this
const STALE_MS = 5_000;

class BinanceFeed {
  private prices = new Map<string, CexPrice>();
  private ws:       WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  // symbols: Binance stream names e.g. 'ethusdc', 'btcusdc'
  constructor(private readonly symbols: string[]) {}

  start(): void {
    this.connect();
  }

  private connect(): void {
    const streams = this.symbols.map(s => `${s}@bookTicker`).join('/');
    const url     = `wss://stream.binance.com:9443/stream?streams=${streams}`;

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log(`[CEX] Binance feed connected (${this.symbols.join(', ')})`);
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
      console.warn('[CEX] Binance disconnected — reconnecting in 3s');
      this.reconnectTimer = setTimeout(() => this.connect(), 3_000);
    });

    this.ws.on('error', (err) => {
      console.error('[CEX] Binance WebSocket error:', err.message);
    });
  }

  getMid(symbol: string): number | null {
    const p = this.prices.get(symbol.toLowerCase());
    if (!p) return null;
    if (Date.now() - p.updatedAtMs > STALE_MS) return null;
    return p.mid;
  }

  // Returns divergence in bps between CEX mid and DEX price
  // Positive = DEX is above CEX (potential sell-on-DEX arb)
  getDivergenceBps(symbol: string, dexPrice: number): number | null {
    const mid = this.getMid(symbol);
    if (mid === null || mid === 0) return null;
    return ((dexPrice - mid) / mid) * 10_000;
  }

  isStale(symbol: string): boolean {
    const p = this.prices.get(symbol.toLowerCase());
    return !p || Date.now() - p.updatedAtMs > STALE_MS;
  }

  destroy(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.terminate();
  }
}

// Singleton — shared across scan cycles
let _feed: BinanceFeed | null = null;

export function getCexFeed(): BinanceFeed {
  if (!_feed) {
    _feed = new BinanceFeed(['ethusdc', 'btcusdc']);
    _feed.start();
  }
  return _feed;
}
