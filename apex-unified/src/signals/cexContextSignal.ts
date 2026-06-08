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

const CEX_MAX_RECONNECTS  = 8;
const CEX_BASE_DELAY_MS   = 3_000;
const CEX_MAX_DELAY_MS    = 300_000; // 5 min cap

class BinanceFeed {
  private prices          = new Map<string, CexPrice>();
  private ws:               WebSocket | null = null;
  private reconnectTimer:   NodeJS.Timeout | null = null;
  private reconnectCount  = 0;
  private disabled        = false;

  constructor(private readonly symbols: string[]) {}

  start(): void {
    this.connect();
  }

  private connect(): void {
    if (this.disabled) return;

    const streams = this.symbols.map(s => `${s}@bookTicker`).join('/');
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.reconnectCount = 0;
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
      if (this.disabled) return;
      if (this.reconnectCount >= CEX_MAX_RECONNECTS) {
        logger.warn('CEX', `Binance feed disabled after ${this.reconnectCount} failed reconnects (geo-block or network issue)`);
        this.disabled = true;
        return;
      }
      const delay = Math.min(CEX_BASE_DELAY_MS * Math.pow(2, this.reconnectCount), CEX_MAX_DELAY_MS);
      this.reconnectCount++;
      logger.warn('CEX', `Binance disconnected — reconnect ${this.reconnectCount}/${CEX_MAX_RECONNECTS} in ${Math.round(delay / 1000)}s`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });

    this.ws.on('error', (err) => {
      // 451 = geo-blocked (legal block), disable immediately
      if (err.message.includes('451')) {
        logger.warn('CEX', 'Binance geo-blocked (HTTP 451) — CEX feed disabled. DEX scanning unaffected.');
        this.disabled = true;
        return;
      }
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
    // Binance streams require USDT symbols; message handler normalises to USDC keys
    _feed = new BinanceFeed(['ethusdt', 'btcusdt']);
    _feed.start();
  }
  return _feed;
}

export function destroyCexFeed(): void {
  _feed?.destroy();
  _feed = null;
}
