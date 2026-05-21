// src/infrastructure/supabaseLogger.ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import CONFIG from '../config/constants';

let supabase: SupabaseClient | null = null;

export interface OpportunityLog {
  block_number:        number;
  token_in:            string;
  token_out:           string;
  dex_buy:             string;
  dex_sell:            string;
  amount_in_usdc:      string;
  expected_profit_usdc:string;
  score_bps:           number;
  quotes_json:         any;
  slippage_estimate_bps:number;
  gas_cost_wei:        string;
  status:              'detected' | 'queued' | 'simulated' | 'executed' | 'failed';
  error_message?:      string;
  liquidity_usd?:      number;
}

export interface TradeLog {
  block_number:      number;
  tx_hash:           string;
  bundle_hash?:      string;
  builder_used:      string;
  token_in:          string;
  token_out:         string;
  amount_in_usdc:    string;
  actual_profit_usdc:string;
  gas_cost_wei:      string;
  gas_price_gwei:    number;
  execution_time_ms: number;
  status:            'pending' | 'included' | 'failed' | 'reverted';
}

interface BuilderStatsLog {
  builder_name:     string;
  success:          boolean;
  block_number:     number;
  response_time_ms?:number;
  error_message?:   string;
}

function createMockClient(): SupabaseClient {
  return {
    from: () => ({
      insert: () => Promise.resolve({ data: null, error: null }),
      upsert: () => Promise.resolve({ data: null, error: null }),
      select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
    }),
  } as any;
}

export function initSupabase(): SupabaseClient {
  if (supabase) return supabase;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl?.startsWith('https://') || !supabaseKey?.length) {
    console.warn('[SUPABASE] Missing or invalid credentials — logging disabled');
    return createMockClient();
  }

  try {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('[SUPABASE] ✅ Client initialized');
    return supabase;
  } catch (error) {
    console.error('[SUPABASE] Failed to initialize:', error);
    return createMockClient();
  }
}

function getClient(): SupabaseClient {
  return supabase ?? initSupabase();
}

function fireAndForget(fn: () => Promise<void>): void {
  fn().catch(err => console.error('[SUPABASE] Async error:', err));
}

export function logOpportunity(opp: Partial<OpportunityLog>): void {
  if (!CONFIG.LOG_OPPORTUNITIES) return;
  fireAndForget(async () => {
    const { error } = await getClient().from('opportunities').insert({
      ...opp, created_at: new Date().toISOString(),
    });
    if (error) console.error('[SUPABASE] logOpportunity:', error.message);
  });
}

export function logTrade(trade: Partial<TradeLog>): void {
  fireAndForget(async () => {
    const { error } = await getClient().from('trades').insert({
      ...trade, created_at: new Date().toISOString(),
    });
    if (error) console.error('[SUPABASE] logTrade:', error.message);
  });
}

export function logBuilderStats(stats: BuilderStatsLog): void {
  fireAndForget(async () => {
    const { error } = await getClient().from('builder_stats').insert({
      ...stats, created_at: new Date().toISOString(),
    });
    if (error && CONFIG.LOG_LEVEL === 'debug') {
      console.error('[SUPABASE] logBuilderStats:', error.message);
    }
  });
}

let blacklistCache:    Set<string> = new Set();
let lastBlacklistFetch = 0;

export async function fetchBlacklist(): Promise<Set<string>> {
  const now = Date.now();
  if (now - lastBlacklistFetch < CONFIG.BLACKLIST_REFRESH_MS) return blacklistCache;

  try {
    const { data, error } = await getClient()
      .from('token_blacklist')
      .select('address')
      .eq('is_active', true);

    if (error) {
      console.warn('[SUPABASE] Failed to fetch blacklist:', error.message);
      return blacklistCache;
    }

    if (data) {
      blacklistCache     = new Set(data.map((r: any) => r.address.toLowerCase()));
      lastBlacklistFetch = now;
    }
    return blacklistCache;
  } catch (err) {
    console.error('[SUPABASE] Blacklist fetch error:', err);
    return blacklistCache;
  }
}

export async function getBotStats(hours = 24): Promise<any> {
  try {
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const [{ data: opps }, { data: trades }] = await Promise.all([
      getClient().from('opportunities').select('status,expected_profit_usdc,score_bps').gte('created_at', since),
      getClient().from('trades').select('status,actual_profit_usdc,gas_cost_wei').gte('created_at', since),
    ]);

    return {
      opportunities: { total: opps?.length ?? 0, byStatus: groupBy(opps, 'status') },
      trades:        { total: trades?.length ?? 0, byStatus: groupBy(trades, 'status'), totalProfit: sumField(trades, 'actual_profit_usdc') },
    };
  } catch (err) {
    console.error('[SUPABASE] Stats fetch error:', err);
    return null;
  }
}

function groupBy(arr: any[] | null, key: string): Record<string, number> {
  if (!arr) return {};
  return arr.reduce((acc, item) => {
    const v = item[key] ?? 'unknown';
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}

function sumField(arr: any[] | null, key: string): number {
  if (!arr) return 0;
  return arr.reduce((s, item) => s + (parseFloat(item[key]) || 0), 0);
}

export default { initSupabase, logOpportunity, logTrade, logBuilderStats, fetchBlacklist, getBotStats };
