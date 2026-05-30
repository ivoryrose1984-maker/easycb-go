import CONFIG from './config';

export interface RunContext {
  botId:      string;
  runId:      string;
  strategyId: string;
  chainId:    number;
  dryRun:     boolean;
  allowLive:  boolean;
  startedAt:  string;
}

let _ctx: RunContext | null = null;

export function getRunContext(): RunContext {
  if (!_ctx) {
    _ctx = {
      botId:      CONFIG.BOT_ID,
      runId:      CONFIG.RUN_ID,
      strategyId: CONFIG.STRATEGY_ID,
      chainId:    CONFIG.CHAIN_ID,
      dryRun:     CONFIG.DRY_RUN,
      allowLive:  CONFIG.ALLOW_LIVE,
      startedAt:  new Date().toISOString(),
    };
  }
  return _ctx;
}

export function uptime(startMs: number): string {
  const s = Math.floor((Date.now() - startMs) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h${m}m${s % 60}s`;
}
