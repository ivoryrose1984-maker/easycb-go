import { ethers } from 'ethers';
import { logger } from './logger';

const WSS_BASE_DELAY_MS  = 1_000;
const WSS_MAX_DELAY_MS   = 30_000;
const WSS_MAX_ATTEMPTS   = 10;
const WSS_KEEPALIVE_MS   = 20_000;

export async function createWsProvider(url: string): Promise<ethers.WebSocketProvider> {
  let attempt = 0;
  let delay   = WSS_BASE_DELAY_MS;

  while (attempt < WSS_MAX_ATTEMPTS) {
    try {
      const provider = new ethers.WebSocketProvider(url);
      await provider.getBlockNumber();

      const ws = (provider as any).websocket;
      if (ws && ws.ping) {
        setInterval(() => {
          try { ws.ping?.(); } catch { /* ignore */ }
        }, WSS_KEEPALIVE_MS);
      }

      logger.info('RPC', `Connected to ${url.slice(0, 50)}...`);
      return provider;
    } catch (err: any) {
      attempt++;
      logger.warn('RPC', `Connection attempt ${attempt} failed: ${err.message}`);
      if (attempt >= WSS_MAX_ATTEMPTS) throw new Error(`RPC: max attempts reached for ${url}`);
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, WSS_MAX_DELAY_MS);
    }
  }

  throw new Error('RPC: unreachable');
}
