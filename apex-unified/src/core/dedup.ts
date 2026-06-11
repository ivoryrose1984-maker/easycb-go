import { createHash } from 'crypto';

const MAX_SIZE         = 10_000;
const ROUTE_TTL_BLOCKS = 3; // same route+quotes within N blocks = duplicate

// Maps hash -> block number when first seen; entry expires after ROUTE_TTL_BLOCKS
const seen = new Map<string, number>();

export function opportunityHash(fields: {
  chainId:      number;
  // blockNumber intentionally excluded: same route+quotes across consecutive blocks
  // is a persistent spread (thin liquidity), not N independent opportunities
  strategyId:   string;
  feeTier:      number;
  tokenIn:      string;
  tokenOut:     string;
  quotedInput:  string;
  quotedOutput: string;
}): string {
  const input = [
    fields.chainId,
    fields.strategyId,
    fields.feeTier,
    fields.tokenIn.toLowerCase(),
    fields.tokenOut.toLowerCase(),
    fields.quotedInput,
    fields.quotedOutput,
  ].join('|');
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export function isNewOpportunity(hash: string, blockNumber: number): boolean {
  const lastBlock = seen.get(hash);
  if (lastBlock !== undefined && blockNumber - lastBlock < ROUTE_TTL_BLOCKS) return false;

  if (seen.size >= MAX_SIZE) {
    for (const [k, bn] of seen) {
      if (blockNumber - bn >= ROUTE_TTL_BLOCKS) {
        seen.delete(k);
        if (seen.size < MAX_SIZE) break;
      }
    }
  }

  seen.set(hash, blockNumber);
  return true;
}

export function clearDedup(): void {
  seen.clear();
}
