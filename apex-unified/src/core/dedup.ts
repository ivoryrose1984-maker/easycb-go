import { createHash } from 'crypto';

const seen = new Set<string>();
const MAX_SIZE = 10_000;

export function opportunityHash(fields: {
  chainId:    number;
  blockNumber: number;
  strategyId: string;
  feeTier:    number;
  tokenIn:    string;
  tokenOut:   string;
  quotedInput: string;
  quotedOutput: string;
}): string {
  const input = [
    fields.chainId,
    fields.blockNumber,
    fields.strategyId,
    fields.feeTier,
    fields.tokenIn.toLowerCase(),
    fields.tokenOut.toLowerCase(),
    fields.quotedInput,
    fields.quotedOutput,
  ].join('|');
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export function isNewOpportunity(hash: string): boolean {
  if (seen.has(hash)) return false;
  if (seen.size >= MAX_SIZE) {
    const first = seen.values().next().value;
    if (first) seen.delete(first);
  }
  seen.add(hash);
  return true;
}

export function clearDedup(): void {
  seen.clear();
}
