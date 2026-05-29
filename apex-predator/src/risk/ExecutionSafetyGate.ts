export interface SafetyConfig {
  dryRun:    boolean;
  allowLive: boolean;
  chainId:   number;
}

export interface GateResult {
  allowed: boolean;
  reason:  string;
}

export function checkExecutionAllowed(cfg: SafetyConfig): GateResult {
  if (cfg.dryRun) {
    return { allowed: false, reason: 'DRY_RUN=true — execution blocked' };
  }
  if (cfg.allowLive !== true) {
    return { allowed: false, reason: 'ALLOW_LIVE is not true — execution blocked' };
  }
  if (cfg.chainId !== 8453) {
    return { allowed: false, reason: `Wrong chain ${cfg.chainId} — only Base (8453) allowed` };
  }
  return { allowed: true, reason: 'All safety checks passed' };
}

// Hard throw variant — use before any sign/broadcast call
export function requireLiveAllowed(cfg: SafetyConfig): void {
  const result = checkExecutionAllowed(cfg);
  if (!result.allowed) {
    throw new Error(`LIVE_EXECUTION_DISABLED: ${result.reason}`);
  }
}
