import CONFIG from './config';

export interface GateResult {
  allowed: boolean;
  reason:  string;
}

export function checkExecutionAllowed(): GateResult {
  if (CONFIG.DRY_RUN) {
    return { allowed: false, reason: 'DRY_RUN=true — execution blocked' };
  }
  if (!CONFIG.ALLOW_LIVE) {
    return { allowed: false, reason: 'ALLOW_LIVE is not true — execution blocked' };
  }
  if (CONFIG.CHAIN_ID !== 8453) {
    return { allowed: false, reason: `Wrong chain ${CONFIG.CHAIN_ID} — only Base (8453) allowed` };
  }
  if (!process.env.PRIVATE_KEY) {
    return { allowed: false, reason: 'PRIVATE_KEY not set — cannot sign transactions' };
  }
  if (CONFIG.CONTRACTS.APEX_FLASH_LOAN === '0x0000000000000000000000000000000000000000') {
    return { allowed: false, reason: 'APEX_FLASH_LOAN_BASE is zero address — deploy contract first' };
  }
  return { allowed: true, reason: 'All safety checks passed' };
}

export function requireLiveAllowed(): void {
  const result = checkExecutionAllowed();
  if (!result.allowed) {
    throw new Error(`LIVE_EXECUTION_DISABLED: ${result.reason}`);
  }
}

export function assertDryRunMode(): void {
  if (!CONFIG.DRY_RUN) {
    throw new Error('assertDryRunMode: DRY_RUN is not true — refusing to start');
  }
  if (CONFIG.ALLOW_LIVE) {
    throw new Error('assertDryRunMode: ALLOW_LIVE=true in dry-run script — refusing to start');
  }
}
