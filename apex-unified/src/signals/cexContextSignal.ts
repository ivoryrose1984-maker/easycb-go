import WebSocket from 'ws';
import { logger } from '../core/logger';
import CONFIG from '../core/config';

export interface CexPrice {
  symbol:      string;
  bid:         number;
  ask:         number;
  mid:         number;
  updatedAtMs: number;
}

const STALE_MS           = 5_000;
const CEX_MAX_RECONNECTS = 8;
const CEX_BASE_DELAY_MS  = 3_000;
const CEX_MAX_DELAY_MS   = 300_000; // 5 min cap

// ── Shared interface ──────────────────────────────────────────────────────────

export interface CexFeed {
  getMid(symbol: string): number | null;
  getDivergenceBps(symbol: string, dexPrice: number): number | null;
  isStale(symbol: string): boolean;
  getAll(): Map<string, CexPrice>;
  destroy(): void;
}

// ── Binance feed ──────────────────────────────────────────────────────────────
// Geo-blocked on Hetzner (HTTP 451). ENABLE_BINANCE=false by default.
// If accessible, provides ~10ms latency via bookTicker WebSocket stream.

class BinanceFeed implements CexFeed {
  private prices         = new Map<string, CexPrice>();
  private ws:              WebSocket | null = null;
  private reconnectTimer:  NodeJS.Timeout | null = null;
  private reconnectCount = 0;
  private disabled       = false;

  constructor(private readonly symbols: string[]) {}

  start(): void { this.connect(); }

  private connect(): void {
    if (this.disabled) return;
    const streams = this.symbols.map(s => `${s}@bookTicker`).join('/');
    this.ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);

    this.ws.on('open', () => {
      this.reconnectCount = 0;
      logger.info('CEX', `Binance connected (${this.symbols.join(', ')})`);
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
        logger.warn('CEX', `Binance disabled after ${this.reconnectCount} failed reconnects`);
        this.disabled = true;
        return;
      }
      const delay = Math.min(CEX_BASE_DELAY_MS * Math.pow(2, this.reconnectCount), CEX_MAX_DELAY_MS);
      this.reconnectCount++;
      logger.warn('CEX', `Binance disconnected — reconnect ${this.reconnectCount}/${CEX_MAX_RECONNECTS} in ${Math.round(delay / 1000)}s`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });

    this.ws.on('error', (err) => {
      if (err.message.includes('451')) {
        logger.warn('CEX', 'Binance geo-blocked (HTTP 451) — disabled. Kraken/CoinGecko covering CEX context.');
        this.disabled = true;
        return;
      }
      logger.error('CEX', `Binance error: ${err.message}`);
    });
  }

  getMid(symbol: string): number | null {
    const p = this.prices.get(symbol.toLowerCase());
    if (!p || Date.now() - p.updatedAtMs > STALE_MS) return null;
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

  getAll(): Map<string, CexPrice> { return this.prices; }

  destroy(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.terminate();
  }
}

// ── Kraken feed ───────────────────────────────────────────────────────────────
// wss://ws.kraken.com — public, no auth, no geo-block on Hetzner.
// ENABLE_KRAKEN=true by default; provides ~50ms latency via ticker subscription.
// Ticker messages: [channelID, {b:[bid,...], a:[ask,...],...}, "ticker", "ETH/USD"]

const KRAKEN_PAIR_MAP: Record<string, string> = {
  'ETH/USD': 'ethusdc',
  'XBT/USD': 'btcusdc',
};

class KrakenFeed implements CexFeed {
  private prices         = new Map<string, CexPrice>();
  private ws:              WebSocket | null = null;
  private reconnectTimer:  NodeJS.Timeout | null = null;
  private reconnectCount = 0;
  private disabled       = false;

  constructor(private readonly pairs: string[]) {}

  start(): void { this.connect(); }

  private connect(): void {
    if (this.disabled) return;
    this.ws = new WebSocket('wss://ws.kraken.com');

    this.ws.on('open', () => {
      this.reconnectCount = 0;
      logger.info('CEX', `Kraken connected (${this.pairs.join(', ')})`);
      this.ws!.send(JSON.stringify({
        event: 'subscribe',
        pair:  this.pairs,
        subscription: { name: 'ticker' },
      }));
    });

    this.ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (!Array.isArray(msg)) return; // skip event objects: heartbeat, subscriptionStatus, systemStatus
        const [, data, type, pairName] = msg as [unknown, Record<string, string[]>, string, string];
        if (type !== 'ticker' || !data || !pairName) return;
        const sym = KRAKEN_PAIR_MAP[pairName];
        if (!sym) return;
        const bid = parseFloat(data.b[0]);
        const ask = parseFloat(data.a[0]);
        if (!isFinite(bid) || !isFinite(ask)) return;
        this.prices.set(sym, { symbol: sym, bid, ask, mid: (bid + ask) / 2, updatedAtMs: Date.now() });
      } catch { /* ignore parse errors */ }
    });

    this.ws.on('close', () => {
      if (this.disabled) return;
      if (this.reconnectCount >= CEX_MAX_RECONNECTS) {
        logger.warn('CEX', `Kraken disabled after ${this.reconnectCount} failed reconnects`);
        this.disabled = true;
        return;
      }
      const delay = Math.min(CEX_BASE_DELAY_MS * Math.pow(2, this.reconnectCount), CEX_MAX_DELAY_MS);
      this.reconnectCount++;
      logger.warn('CEX', `Kraken disconnected — reconnect ${this.reconnectCount}/${CEX_MAX_RECONNECTS} in ${Math.round(delay / 1000)}s`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });

    this.ws.on('error', (err) => {
      logger.error('CEX', `Kraken error: ${err.message}`);
    });
  }

  getMid(symbol: string): number | null {
    const p = this.prices.get(symbol.toLowerCase());
    if (!p || Date.now() - p.updatedAtMs > STALE_MS) return null;
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

  getAll(): Map<string, CexPrice> { return this.prices; }

  destroy(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.terminate();
  }
}

// ── Combined feed — tries feeds in order, first non-stale value wins ──────────

class CombinedCexFeed implements CexFeed {
  constructor(private readonly feeds: CexFeed[]) {}

  getMid(symbol: string): number | null {
    for (const feed of this.feeds) {
      const mid = feed.getMid(symbol);
      if (mid !== null) return mid;
    }
    return null;
  }

  getDivergenceBps(symbol: string, dexPrice: number): number | null {
    const mid = this.getMid(symbol);
    if (mid === null || mid === 0) return null;
    return ((dexPrice - mid) / mid) * 10_000;
  }

  isStale(symbol: string): boolean {
    return this.feeds.every(f => f.isStale(symbol));
  }

  getAll(): Map<string, CexPrice> {
    // Reverse so first feed overwrites last — first feed's prices win on key collision.
    // Also apply same staleness gate as getMid() so callers don't see stale prices.
    const combined = new Map<string, CexPrice>();
    const now = Date.now();
    for (const feed of [...this.feeds].reverse()) {
      for (const [k, v] of feed.getAll()) {
        if (now - v.updatedAtMs <= STALE_MS) combined.set(k, v);
      }
    }
    return combined;
  }

  destroy(): void { this.feeds.forEach(f => f.destroy()); }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _feed: CombinedCexFeed | null = null;

export function getCexFeed(): CombinedCexFeed {
  if (!_feed) {
    const feeds: CexFeed[] = [];

    if (CONFIG.ENABLE_BINANCE) {
      const b = new BinanceFeed(['ethusdt', 'btcusdt']);
      b.start();
      feeds.push(b);
    }

    if (CONFIG.ENABLE_KRAKEN) {
      const k = new KrakenFeed(['ETH/USD', 'XBT/USD']);
      k.start();
      feeds.push(k);
    }

    _feed = new CombinedCexFeed(feeds);
  }
  return _feed;
}

export function destroyCexFeed(): void {
  _feed?.destroy();
  _feed = null;
}

// ── CoinGecko REST price feed ─────────────────────────────────────────────────
// Last-resort fallback — polled on-demand, 30s in-memory cache.
// Used when both Binance and Kraken are unavailable.
// No API key required, no geo-restrictions on Hetzner.

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price' +
  '?ids=ethereum,coinbase-wrapped-staked-eth,bitcoin&vs_currencies=usd';

const CG_CACHE_MS = 30_000;

interface CgCache { ethUsd: number; cbethUsd: number; cbethRatio: number; btcUsd: number; fetchedAt: number }
let _cgCache: CgCache | null = null;

export async function getCoinGeckoPrice(): Promise<{ ethUsd: number; cbethUsd: number; cbethRatio: number; btcUsd: number } | null> {
  if (_cgCache && Date.now() - _cgCache.fetchedAt < CG_CACHE_MS) {
    return { ethUsd: _cgCache.ethUsd, cbethUsd: _cgCache.cbethUsd, cbethRatio: _cgCache.cbethRatio, btcUsd: _cgCache.btcUsd };
  }
  try {
    const res = await fetch(COINGECKO_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as Record<string, { usd: number }>;
    const ethUsd   = data['ethereum']?.usd;
    const cbethUsd = data['coinbase-wrapped-staked-eth']?.usd;
    const btcUsd   = data['bitcoin']?.usd;
    if (!ethUsd || !cbethUsd || !btcUsd) throw new Error('Missing price fields');
    _cgCache = { ethUsd, cbethUsd, cbethRatio: cbethUsd / ethUsd, btcUsd, fetchedAt: Date.now() };
    return { ethUsd: _cgCache.ethUsd, cbethUsd: _cgCache.cbethUsd, cbethRatio: _cgCache.cbethRatio, btcUsd: _cgCache.btcUsd };
  } catch (err: any) {
    logger.warn('CEX', `CoinGecko fetch failed: ${err.message}${_cgCache ? ' — using stale cache' : ''}`);
    if (_cgCache) return { ethUsd: _cgCache.ethUsd, cbethUsd: _cgCache.cbethUsd, cbethRatio: _cgCache.cbethRatio, btcUsd: _cgCache.btcUsd };
    return null;
  }
}
