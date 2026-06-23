import { ethers } from 'ethers';
import CONFIG from '../core/config';
import { logger } from '../core/logger';

const STALL_TIMEOUT_MS = 2_000;

let _instance: ethers.Provider | null = null;

export function getHttpProvider(): ethers.Provider | null {
  if (_instance) return _instance;

  // BASE_HTTPS_URLS (comma-separated) takes priority over legacy BASE_HTTPS_URL
  const raw  = (process.env.BASE_HTTPS_URLS ?? '').trim()
            || (process.env.BASE_HTTPS_URL  ?? '').trim();
  const urls = raw.split(',').map(u => u.trim()).filter(Boolean);

  if (urls.length === 0) return null;

  if (urls.length === 1) {
    const network = ethers.Network.from(CONFIG.CHAIN_ID);
    _instance = new ethers.JsonRpcProvider(urls[0], network, { staticNetwork: network });
    logger.info('HTTP', `Single HTTP provider configured`);
    return _instance;
  }

  const network = ethers.Network.from(CONFIG.CHAIN_ID);
  _instance = new ethers.FallbackProvider(
    urls.map(url => ({
      provider:     new ethers.JsonRpcProvider(url, network, { staticNetwork: network }),
      stallTimeout: STALL_TIMEOUT_MS,
      priority:     1,
      weight:       1,
    })),
    network,
    { quorum: 1 },
  );
  logger.info('HTTP', `FallbackProvider: ${urls.length} endpoints, quorum=1, stallTimeout=${STALL_TIMEOUT_MS}ms`);
  return _instance;
}

export function _resetHttpProviderForTest(): void { _instance = null; }
