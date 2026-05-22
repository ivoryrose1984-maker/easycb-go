export type BotName = 'apex' | 'go';

export interface Opportunity {
  id: string;
  created_at: string;
  bot: BotName;
  block_number: number | null;
  token_in: string;
  token_out: string;
  token_mid: string | null;
  amount_in_usdc: number;
  expected_profit_usdc: number;
  score_bps: number | null;
  gas_cost_wei: string | null;
  status: 'pending' | 'executing' | 'included' | 'failed' | 'skipped';
  error_message: string | null;
}

export interface Trade {
  id: string;
  created_at: string;
  bot: BotName;
  block_number: number | null;
  tx_hash: string | null;
  token_in: string;
  token_out: string;
  token_mid: string | null;
  amount_in_usdc: number;
  actual_profit_usdc: number;
  gas_cost_wei: string | null;
  gas_price_gwei: number | null;
  execution_time_ms: number | null;
  status: 'pending' | 'included' | 'failed' | 'reverted';
}

export interface BuilderStat {
  id: string;
  created_at: string;
  bot: BotName;
  builder_name: string;
  success: boolean;
  block_number: number | null;
  response_time_ms: number | null;
  error_message: string | null;
}

export interface DashboardStats {
  todayProfit: number;
  sevenDayProfit: number;
  winRate: number;
  totalTrades: number;
  includedTrades: number;
  opportunitiesScannedToday: number;
  apexStats: BotStats;
  goStats: BotStats;
}

export interface BotStats {
  todayProfit: number;
  totalTrades: number;
  includedTrades: number;
  winRate: number;
}

export interface ProfitDataPoint {
  time: string;
  profit: number;
  cumulative: number;
}
