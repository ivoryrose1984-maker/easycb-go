import { ethers }    from 'ethers';
import CONFIG, { weiToEth } from '../core/config';
import { logger }    from '../core/logger';
import { alertCircuitBreaker } from '../infrastructure/telegramAlert';
import { killStrategy } from './strategyKillSwitch';
import { StrategyId }   from '../types/Opportunity';

const ALL_STRATEGIES: StrategyId[] = [
  'apex.dex_spread', 'apex.triangular', 'grok.cbeth_fair_value', 'apex.aerodrome_spread',
];

const GRACE_BLOCKS = 3;

let triggered           = false;
let initialBalance: bigint | null = null;
let consecutiveBreaches = 0;

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
    if (current >= initialBalance) {
      if (consecutiveBreaches > 0) {
        logger.info('CIRCUIT', `Drawdown recovered — resetting grace counter`);
        consecutiveBreaches = 0;
      }
      return;
    }

    const drawdownPct = Number((initialBalance - current) * 10_000n / initialBalance) / 100;
    if (drawdownPct >= CONFIG.DRAWDOWN_THRESHOLD) {
      consecutiveBreaches++;
      if (consecutiveBreaches < GRACE_BLOCKS) {
        logger.warn('CIRCUIT', `Drawdown ${drawdownPct.toFixed(1)}% — grace ${consecutiveBreaches}/${GRACE_BLOCKS}`);
        return;
      }
      triggered = true;
      const msg = `Circuit breaker: ${drawdownPct.toFixed(1)}% drawdown (${GRACE_BLOCKS} consecutive blocks) — halting all execution`;
      logger.error('CIRCUIT', msg);
      for (const id of ALL_STRATEGIES) killStrategy(id, 'circuit breaker triggered');
      await alertCircuitBreaker(msg);
      process.exit(1);
    } else {
      if (consecutiveBreaches > 0) {
        logger.info('CIRCUIT', `Drawdown recovered — resetting grace counter`);
        consecutiveBreaches = 0;
      }
    }
  } catch (err: any) {
    logger.error('CIRCUIT', `Check failed: ${err.message}`);
  }
}

export function resetCircuitBreaker(): void {
  triggered           = false;
  initialBalance      = null;
  consecutiveBreaches = 0;
}
