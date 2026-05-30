import CONFIG from '../core/config';
import { logger } from '../core/logger';

export interface BundleResult {
  success: boolean;
  builder: string;
  txHash:  string | null;
  error:   string | null;
}

export async function submitBundle(
  signedTx:    string,
  targetBlock: number
): Promise<BundleResult> {
  const builders = CONFIG.BUILDERS.filter(b => b.enabled);

  for (const builder of builders) {
    try {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id:      1,
        method:  'eth_sendBundle',
        params:  [{ txs: [signedTx], blockNumber: `0x${targetBlock.toString(16)}` }],
      });

      const res = await fetch(builder.url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal:  AbortSignal.timeout(3_000),
      });

      if (res.ok) {
        const data = await res.json() as { result?: { bundleHash?: string } };
        const txHash = data.result?.bundleHash ?? null;
        logger.info('BUNDLE', `Submitted to ${builder.name}`);
        return { success: true, builder: builder.name, txHash, error: null };
      }

      logger.warn('BUNDLE', `${builder.name} returned ${res.status}`);
    } catch (err: any) {
      logger.warn('BUNDLE', `${builder.name} failed: ${err.message}`);
    }
  }

  return { success: false, builder: 'none', txHash: null, error: 'All builders failed' };
}
