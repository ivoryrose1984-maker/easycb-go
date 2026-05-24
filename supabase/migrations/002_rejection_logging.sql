-- Atlas Extraction 3: rejection reason logging
-- Run in Supabase SQL Editor after 001_arb_tables.sql

create table if not exists opportunity_rejections (
  id             bigserial    primary key,
  timestamp      timestamptz  not null default now(),
  pair           text,
  loan_amount    numeric(20,0),
  reason_code    text         not null,
  net_profit_wei numeric(30,0)
);

create index if not exists idx_rejections_timestamp   on opportunity_rejections (timestamp desc);
create index if not exists idx_rejections_reason_code on opportunity_rejections (reason_code);
create index if not exists idx_rejections_pair        on opportunity_rejections (pair, timestamp desc);

alter table opportunity_rejections enable row level security;
create policy "public read rejections" on opportunity_rejections for select using (true);
