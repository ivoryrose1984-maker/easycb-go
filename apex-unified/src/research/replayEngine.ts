import { readOpportunities } from '../core/jsonlLogger';
import { Opportunity, StrategyId } from '../types/Opportunity';
import { scoreOpportunity } from './opportunityScorer';
import { logger } from '../core/logger';
import * as fs   from 'fs';
import * as path from 'path';

export interface ReplaySession {
  date:         string;
  opportunities: Opportunity[];
  byStrategy:   Map<StrategyId, Opportunity[]>;
}

export async function replayDate(date: string): Promise<ReplaySession> {
  const opps = readOpportunities(date);
  logger.info('REPLAY', `Loaded ${opps.length} opportunities for ${date}`);

  const byStrategy = new Map<StrategyId, Opportunity[]>();
  for (const opp of opps) {
    if (!byStrategy.has(opp.strategyId)) byStrategy.set(opp.strategyId, []);
    byStrategy.get(opp.strategyId)!.push(opp);
  }

  return { date, opportunities: opps, byStrategy };
}

export async function replayRange(startDate: string, endDate: string): Promise<ReplaySession[]> {
  const sessions: ReplaySession[] = [];
  const start = new Date(startDate);
  const end   = new Date(endDate);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    sessions.push(await replayDate(date));
  }

  return sessions;
}

export function filterByStrategy(session: ReplaySession, strategyId: StrategyId): Opportunity[] {
  return session.byStrategy.get(strategyId) ?? [];
}

export function filterAboveBps(opps: Opportunity[], minBps: number): Opportunity[] {
  return opps.filter(o => o.spreadBps >= minBps);
}
