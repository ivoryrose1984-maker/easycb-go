import { ENV } from '../config/env';

export interface GateResult {
  allowed: boolean;
  reason:  string;
}

export function checkExecutionAllowed(): GateResult {
  if (ENV.DRY_RUN)          return { allowed: false, reason: 'DRY_RUN=true — execution blocked' };
  if (!ENV.ALLOW_LIVE)      return { allowed: false, reason: 'ALLOW_LIVE is not true — execution blocked' };
  if (ENV.CHAIN_ID !== 8453) return { allowed: false, reason: `Wrong chain — only Base (8453) allowed` };
  return { allowed: true, reason: 'All safety checks passed' };
}

export function requireLiveAllowed(): void {
  const r = checkExecutionAllowed();
  if (!r.allowed) throw new Error(`LIVE_EXECUTION_DISABLED: ${r.reason}`);
}

// Call once at startup — logs gate status, exits if somehow gate is open during dry-run script
export function assertDryRunMode(): void {
  const r = checkExecutionAllowed();
  if (r.allowed) {
    console.error('FATAL: Safety gate is OPEN in dry-run script. This should never happen. Exiting.');
    process.exit(1);
  }
  console.log(`[GATE] ${r.reason}`);
}
