-- Arbitrage bot database schema
-- Run once in Supabase SQL Editor before starting either bot

-- ─── Opportunities ────────────────────────────────────────────────────────────
create table if not exists opportunities (
  id                    bigserial primary key,
  created_at            timestamptz  not null default now(),
  bot                   text         not null default 'apex',  -- 'apex' | 'go'
  block_number          bigint,
  token_in              text,
  token_out             text,
  token_mid             text,
  dex_buy               text,
  dex_sell              text,
  amount_in_usdc        numeric(20,6),
  expected_profit_usdc  numeric(20,6),
  score_bps             integer,
  slippage_estimate_bps integer,
  gas_cost_wei          numeric(30,0),
  status                text         not null default 'detected',
  error_message         text,
  liquidity_usd         numeric(20,2),
  quotes_json           jsonb
);

-- ─── Trades ───────────────────────────────────────────────────────────────────
create table if not exists trades (
  id                  bigserial primary key,
  created_at          timestamptz  not null default now(),
  bot                 text         not null default 'apex',
  block_number        bigint,
  tx_hash             text         unique,
  bundle_hash         text,
  builder_used        text,
  token_in            text,
  token_out           text,
  token_mid           text,
  amount_in_usdc      numeric(20,6),
  actual_profit_usdc  numeric(20,6),
  gas_cost_wei        numeric(30,0),
  gas_price_gwei      numeric(10,4),
  execution_time_ms   integer,
  status              text         not null default 'pending'
);

-- ─── Builder performance ──────────────────────────────────────────────────────
create table if not exists builder_stats (
  id                bigserial primary key,
  created_at        timestamptz not null default now(),
  bot               text        not null default 'apex',
  builder_name      text        not null,
  success           boolean     not null,
  block_number      bigint,
  response_time_ms  integer,
  error_message     text
);

-- ─── Token blacklist ──────────────────────────────────────────────────────────
create table if not exists token_blacklist (
  address     text        primary key,
  symbol      text,
  reason      text,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
create index if not exists idx_opportunities_created  on opportunities (created_at desc);
create index if not exists idx_opportunities_bot      on opportunities (bot, created_at desc);
create index if not exists idx_opportunities_status   on opportunities (status);
create index if not exists idx_trades_created         on trades (created_at desc);
create index if not exists idx_trades_bot             on trades (bot, created_at desc);
create index if not exists idx_trades_status          on trades (status);
create index if not exists idx_builder_stats_created  on builder_stats (created_at desc);

-- ─── Convenience views ────────────────────────────────────────────────────────
create or replace view daily_stats as
select
  date_trunc('day', created_at) as day,
  bot,
  count(*)                                                          as trade_count,
  count(*) filter (where status = 'included')                       as wins,
  sum(actual_profit_usdc) filter (where status = 'included')        as gross_profit_usdc,
  sum(gas_cost_wei::numeric / 1e18 * 3000)
    filter (where status = 'included')                              as gas_cost_usd,
  sum(actual_profit_usdc) filter (where status = 'included')
    - coalesce(sum(gas_cost_wei::numeric / 1e18 * 3000)
        filter (where status = 'included'), 0)                      as net_profit_usd
from trades
group by 1, 2
order by 1 desc, 2;

-- ─── Realtime (enable in Supabase dashboard: Database → Replication) ──────────
-- Enable realtime on: trades, opportunities
-- This powers the live dashboard feed

-- ─── Row-level security (public read for dashboard) ──────────────────────────
alter table opportunities enable row level security;
alter table trades         enable row level security;
alter table builder_stats  enable row level security;
alter table token_blacklist enable row level security;

create policy "public read opportunities" on opportunities for select using (true);
create policy "public read trades"        on trades        for select using (true);
create policy "public read builder_stats" on builder_stats for select using (true);
create policy "public read blacklist"     on token_blacklist for select using (true);
