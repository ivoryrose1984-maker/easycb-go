import { StrategyId } from '../types/Opportunity';
import { logger } from '../core/logger';

const killed = new Set<StrategyId>();

export function killStrategy(id: StrategyId, reason: string): void {
  killed.add(id);
  logger.warn('KILL', `Strategy ${id} killed: ${reason}`);
}

export function reviveStrategy(id: StrategyId): void {
  killed.delete(id);
  logger.info('KILL', `Strategy ${id} revived`);
}

export function isKilled(id: StrategyId): boolean {
  return killed.has(id);
}

export function getKilled(): StrategyId[] {
  return Array.from(killed);
}
