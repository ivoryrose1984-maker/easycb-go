import { ethers }    from 'ethers';
import CONFIG, { weiToEth } from '../core/config';
import { logger }    from '../core/logger';
import { alertCircuitBreaker } from '../infrastructure/telegramAlert';
import { killStrategy } from './strategyKillSwitch';
import { StrategyId }   from '../types/Opportunity';

const ALL_STRATEGIES: StrategyId[] = [
  'apex.dex_spread', 'apex.triangular', 'grok.cbeth_fair_value', 'apex.aerodrome_spread',
];

let triggered      = false;
let initialBalance: bigint | null = null;

export function isCircuitBroken(): boolean {
  return triggered;
}

export function setInitialBalance(balance: bigint): void {
  initialBalance = balance;
  logger.info('CIRCUIT', `Baseline balance: ${weiToEth(balance).toFixed(4)} ETH`);
}

export async function checkCircuitBreaker(provider: ethers.Provider, address: string): Promise<void> {
  if (triggered || !initialBalance) return;

  try {
    const current = await provider.getBalance(address);
    if (current >= initialBalance) return;

    const drawdownPct = Number((initialBalance - current) * 10_000n / initialBalance) / 100;
    if (drawdownPct >= CONFIG.DRAWDOWN_THRESHOLD) {
      triggered = true;
      const msg = `Circuit breaker: ${drawdownPct.toFixed(1)}% drawdown — halting all execution`;
      logger.error('CIRCUIT', msg);
      for (const id of ALL_STRATEGIES) killStrategy(id, 'circuit breaker triggered');
      await alertCircuitBreaker(msg);
      process.exit(1);
    }
  } catch (err: any) {
    logger.error('CIRCUIT', `Check failed: ${err.message}`);
  }
}

export function resetCircuitBreaker(): void {
  triggered      = false;
  initialBalance = null;
}
