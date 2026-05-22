'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import type { Trade, Opportunity, DashboardStats, BotStats } from '@/lib/types';
import { formatUSDC, formatPath, formatTime, formatBps, formatCompact } from '@/lib/format';
import { RealtimePostgresInsertPayload } from '@supabase/supabase-js';

// ─── Sub-components ──────────────────────────────────────────────────────────

function LiveClock() {
  const [time, setTime] = useState('');

  useEffect(() => {
    const tick = () =>
      setTime(
        new Date().toLocaleTimeString('en-US', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return <span className="text-zinc-400 text-sm tabular-nums">{time}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    included: 'bg-emerald-950 text-emerald-400 border border-emerald-800',
    failed: 'bg-red-950 text-red-400 border border-red-800',
    reverted: 'bg-red-950 text-red-400 border border-red-800',
    pending: 'bg-yellow-950 text-yellow-400 border border-yellow-800',
    executing: 'bg-blue-950 text-blue-400 border border-blue-800',
    skipped: 'bg-zinc-900 text-zinc-400 border border-zinc-700',
  };
  const cls = map[status] ?? 'bg-zinc-900 text-zinc-400 border border-zinc-700';
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono uppercase tracking-wide ${cls}`}>
      {status}
    </span>
  );
}

function BotBadge({ bot }: { bot: string }) {
  const cls =
    bot === 'apex'
      ? 'text-violet-400 bg-violet-950 border border-violet-800'
      : 'text-cyan-400 bg-cyan-950 border border-cyan-800';
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono uppercase tracking-wide ${cls}`}>
      {bot}
    </span>
  );
}

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  valueColor?: string;
}

function StatCard({ label, value, sub, valueColor = 'text-white' }: StatCardProps) {
  return (
    <div className="rounded-lg border border-zinc-800 p-4" style={{ backgroundColor: '#111111' }}>
      <p className="text-xs text-zinc-500 uppercase tracking-widest mb-1">{label}</p>
      <p className={`text-2xl font-bold tabular-nums ${valueColor}`}>{value}</p>
      {sub && <p className="text-xs text-zinc-500 mt-1">{sub}</p>}
    </div>
  );
}

interface BotCardProps {
  name: string;
  stats: BotStats;
  color: string;
}

function BotCard({ name, stats, color }: BotCardProps) {
  return (
    <div className="rounded-lg border border-zinc-800 p-4 flex-1" style={{ backgroundColor: '#111111' }}>
      <div className="flex items-center gap-2 mb-3">
        <span className={`text-sm font-bold uppercase tracking-widest ${color}`}>{name}</span>
        <span className="text-xs text-zinc-600">bot</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-xs text-zinc-500 uppercase tracking-widest mb-0.5">Today P&L</p>
          <p className={`text-lg font-bold tabular-nums ${stats.todayProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {formatUSDC(stats.todayProfit)}
          </p>
        </div>
        <div>
          <p className="text-xs text-zinc-500 uppercase tracking-widest mb-0.5">Win Rate</p>
          <p className="text-lg font-bold tabular-nums text-white">
            {stats.totalTrades === 0 ? '—' : `${((stats.includedTrades / stats.totalTrades) * 100).toFixed(1)}%`}
          </p>
        </div>
        <div>
          <p className="text-xs text-zinc-500 uppercase tracking-widest mb-0.5">Trades</p>
          <p className="text-lg font-bold tabular-nums text-white">{stats.totalTrades}</p>
        </div>
        <div>
          <p className="text-xs text-zinc-500 uppercase tracking-widest mb-0.5">Included</p>
          <p className="text-lg font-bold tabular-nums text-emerald-400">{stats.includedTrades}</p>
        </div>
      </div>
    </div>
  );
}

function LoadingRow({ cols }: { cols: number }) {
  return (
    <tr>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-3 py-2">
          <div className="h-4 rounded bg-zinc-800 animate-pulse" style={{ width: `${60 + Math.random() * 40}%` }} />
        </td>
      ))}
    </tr>
  );
}

function EmptyRow({ cols, message }: { cols: number; message: string }) {
  return (
    <tr>
      <td colSpan={cols} className="px-3 py-8 text-center text-zinc-600 text-sm">
        {message}
      </td>
    </tr>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

const EMPTY_STATS: DashboardStats = {
  todayProfit: 0,
  sevenDayProfit: 0,
  winRate: 0,
  totalTrades: 0,
  includedTrades: 0,
  opportunitiesScannedToday: 0,
  apexStats: { todayProfit: 0, totalTrades: 0, includedTrades: 0, winRate: 0 },
  goStats: { todayProfit: 0, totalTrades: 0, includedTrades: 0, winRate: 0 },
};

function todayISO(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function sevenDaysAgoISO(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats>(EMPTY_STATS);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<string>('');

  // ── Data fetching ──────────────────────────────────────────────────────────

  const fetchStats = useCallback(async () => {
    const today = todayISO();
    const sevenDaysAgo = sevenDaysAgoISO();

    const [
      { data: todayTrades },
      { data: weekTrades },
      { data: oppsToday },
    ] = await Promise.all([
      supabase
        .from('trades')
        .select('bot, actual_profit_usdc, status')
        .gte('created_at', today),
      supabase
        .from('trades')
        .select('actual_profit_usdc, status')
        .gte('created_at', sevenDaysAgo),
      supabase
        .from('opportunities')
        .select('id')
        .gte('created_at', today),
    ]);

    const todayTradesArr = todayTrades ?? [];
    const weekTradesArr = weekTrades ?? [];

    const todayProfit = todayTradesArr
      .filter((t) => t.status === 'included')
      .reduce((sum: number, t: { actual_profit_usdc: number }) => sum + (t.actual_profit_usdc ?? 0), 0);

    const sevenDayProfit = weekTradesArr
      .filter((t) => t.status === 'included')
      .reduce((sum: number, t: { actual_profit_usdc: number }) => sum + (t.actual_profit_usdc ?? 0), 0);

    const totalTrades = todayTradesArr.length;
    const includedTrades = todayTradesArr.filter((t) => t.status === 'included').length;
    const winRate = totalTrades > 0 ? (includedTrades / totalTrades) * 100 : 0;

    // Per-bot breakdown
    const apexToday = todayTradesArr.filter((t) => t.bot === 'apex');
    const goToday = todayTradesArr.filter((t) => t.bot === 'go');

    function botStats(arr: { actual_profit_usdc: number; status: string }[]): BotStats {
      const inc = arr.filter((t) => t.status === 'included');
      const profit = inc.reduce((s, t) => s + (t.actual_profit_usdc ?? 0), 0);
      return {
        todayProfit: profit,
        totalTrades: arr.length,
        includedTrades: inc.length,
        winRate: arr.length > 0 ? (inc.length / arr.length) * 100 : 0,
      };
    }

    setStats({
      todayProfit,
      sevenDayProfit,
      winRate,
      totalTrades,
      includedTrades,
      opportunitiesScannedToday: oppsToday?.length ?? 0,
      apexStats: botStats(apexToday),
      goStats: botStats(goToday),
    });
  }, []);

  const fetchTrades = useCallback(async () => {
    const { data } = await supabase
      .from('trades')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);
    setTrades((data as Trade[]) ?? []);
  }, []);

  const fetchOpportunities = useCallback(async () => {
    const { data } = await supabase
      .from('opportunities')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);
    setOpportunities((data as Opportunity[]) ?? []);
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([fetchStats(), fetchTrades(), fetchOpportunities()]);
    setLastUpdate(new Date().toLocaleTimeString('en-US', { hour12: false }));
  }, [fetchStats, fetchTrades, fetchOpportunities]);

  // ── Initial load ───────────────────────────────────────────────────────────

  useEffect(() => {
    refreshAll().finally(() => setIsLoading(false));
  }, [refreshAll]);

  // ── Realtime subscriptions ─────────────────────────────────────────────────

  useEffect(() => {
    const tradesChannel = supabase
      .channel('trades-live')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'trades' },
        (payload: RealtimePostgresInsertPayload<Trade>) => {
          const newTrade = payload.new as Trade;
          setTrades((prev) => [newTrade, ...prev].slice(0, 20));
          setLastUpdate(new Date().toLocaleTimeString('en-US', { hour12: false }));
          // Re-fetch stats so profit/winrate numbers stay accurate
          fetchStats();
        }
      )
      .subscribe((status) => {
        setIsConnected(status === 'SUBSCRIBED');
      });

    const oppsChannel = supabase
      .channel('opportunities-live')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'opportunities' },
        (payload: RealtimePostgresInsertPayload<Opportunity>) => {
          const newOpp = payload.new as Opportunity;
          setOpportunities((prev) => [newOpp, ...prev].slice(0, 10));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(tradesChannel);
      supabase.removeChannel(oppsChannel);
    };
  }, [fetchStats]);

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <main className="min-h-screen font-mono" style={{ backgroundColor: '#0a0a0a' }}>
      <div className="max-w-[1400px] mx-auto px-4 py-6 space-y-6">

        {/* ── Header ── */}
        <header className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold tracking-[0.2em] text-white uppercase">
              ARB DASHBOARD
            </h1>
            <div className="flex items-center gap-1.5">
              <span
                className={`live-dot inline-block w-2 h-2 rounded-full ${
                  isConnected ? 'bg-emerald-400' : 'bg-yellow-400'
                }`}
              />
              <span
                className={`text-xs uppercase tracking-widest ${
                  isConnected ? 'text-emerald-400' : 'text-yellow-400'
                }`}
              >
                {isConnected ? 'LIVE' : 'CONNECTING'}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs text-zinc-500">
            {lastUpdate && (
              <span>
                Updated <span className="text-zinc-400">{lastUpdate}</span>
              </span>
            )}
            <LiveClock />
          </div>
        </header>

        {/* ── Stats Row ── */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="Today's Profit"
            value={isLoading ? '—' : formatUSDC(stats.todayProfit)}
            sub={`${stats.includedTrades} winning trades`}
            valueColor={stats.todayProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}
          />
          <StatCard
            label="7-Day Profit"
            value={isLoading ? '—' : formatUSDC(stats.sevenDayProfit)}
            sub="rolling window"
            valueColor={stats.sevenDayProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}
          />
          <StatCard
            label="Win Rate"
            value={isLoading ? '—' : stats.totalTrades === 0 ? '—' : `${stats.winRate.toFixed(1)}%`}
            sub={`${stats.includedTrades} / ${stats.totalTrades} today`}
            valueColor="text-white"
          />
          <StatCard
            label="Opps Scanned"
            value={isLoading ? '—' : formatCompact(stats.opportunitiesScannedToday)}
            sub="today"
            valueColor="text-white"
          />
        </section>

        {/* ── Bot Comparison ── */}
        <section>
          <h2 className="text-xs text-zinc-500 uppercase tracking-widest mb-3">Bots — Today</h2>
          <div className="flex gap-3 flex-col sm:flex-row">
            <BotCard name="apex" stats={stats.apexStats} color="text-violet-400" />
            <BotCard name="go" stats={stats.goStats} color="text-cyan-400" />
          </div>
        </section>

        {/* ── Recent Trades ── */}
        <section>
          <h2 className="text-xs text-zinc-500 uppercase tracking-widest mb-3">
            Recent Trades
            <span className="ml-2 text-zinc-700">last 20</span>
          </h2>
          <div
            className="rounded-lg border border-zinc-800 overflow-hidden"
            style={{ backgroundColor: '#111111' }}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800">
                    <th className="px-3 py-2 text-left text-xs text-zinc-500 uppercase tracking-widest font-normal">
                      Time
                    </th>
                    <th className="px-3 py-2 text-left text-xs text-zinc-500 uppercase tracking-widest font-normal">
                      Bot
                    </th>
                    <th className="px-3 py-2 text-left text-xs text-zinc-500 uppercase tracking-widest font-normal">
                      Path
                    </th>
                    <th className="px-3 py-2 text-right text-xs text-zinc-500 uppercase tracking-widest font-normal">
                      Loan
                    </th>
                    <th className="px-3 py-2 text-right text-xs text-zinc-500 uppercase tracking-widest font-normal">
                      Profit
                    </th>
                    <th className="px-3 py-2 text-center text-xs text-zinc-500 uppercase tracking-widest font-normal">
                      Status
                    </th>
                    <th className="px-3 py-2 text-left text-xs text-zinc-500 uppercase tracking-widest font-normal">
                      TX
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900">
                  {isLoading ? (
                    Array.from({ length: 5 }).map((_, i) => <LoadingRow key={i} cols={7} />)
                  ) : trades.length === 0 ? (
                    <EmptyRow cols={7} message="No trades yet" />
                  ) : (
                    trades.map((trade) => (
                      <tr key={trade.id} className="trade-row transition-colors">
                        <td className="px-3 py-2 text-zinc-400 whitespace-nowrap tabular-nums">
                          {formatTime(trade.created_at)}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <BotBadge bot={trade.bot} />
                        </td>
                        <td className="px-3 py-2 text-zinc-300 whitespace-nowrap text-xs">
                          {formatPath(trade.token_in, trade.token_mid, trade.token_out)}
                        </td>
                        <td className="px-3 py-2 text-right text-zinc-300 tabular-nums whitespace-nowrap">
                          {formatUSDC(trade.amount_in_usdc)}
                        </td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums font-bold whitespace-nowrap ${
                            trade.actual_profit_usdc > 0
                              ? 'text-emerald-400'
                              : trade.actual_profit_usdc < 0
                              ? 'text-red-400'
                              : 'text-zinc-400'
                          }`}
                        >
                          {formatUSDC(trade.actual_profit_usdc)}
                        </td>
                        <td className="px-3 py-2 text-center whitespace-nowrap">
                          <StatusBadge status={trade.status} />
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {trade.tx_hash ? (
                            <a
                              href={`https://basescan.org/tx/${trade.tx_hash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-zinc-500 hover:text-emerald-400 transition-colors font-mono"
                            >
                              {trade.tx_hash.slice(0, 6)}…{trade.tx_hash.slice(-4)}
                            </a>
                          ) : (
                            <span className="text-zinc-700 text-xs">—</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ── Live Opportunities ── */}
        <section>
          <h2 className="text-xs text-zinc-500 uppercase tracking-widest mb-3">
            Live Opportunities
            <span className="ml-2 text-zinc-700">last 10 · auto-updates</span>
          </h2>
          <div
            className="rounded-lg border border-zinc-800 overflow-hidden"
            style={{ backgroundColor: '#111111' }}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800">
                    <th className="px-3 py-2 text-left text-xs text-zinc-500 uppercase tracking-widest font-normal">
                      Time
                    </th>
                    <th className="px-3 py-2 text-left text-xs text-zinc-500 uppercase tracking-widest font-normal">
                      Bot
                    </th>
                    <th className="px-3 py-2 text-left text-xs text-zinc-500 uppercase tracking-widest font-normal">
                      Path
                    </th>
                    <th className="px-3 py-2 text-right text-xs text-zinc-500 uppercase tracking-widest font-normal">
                      Score
                    </th>
                    <th className="px-3 py-2 text-right text-xs text-zinc-500 uppercase tracking-widest font-normal">
                      Exp. Profit
                    </th>
                    <th className="px-3 py-2 text-right text-xs text-zinc-500 uppercase tracking-widest font-normal">
                      Loan
                    </th>
                    <th className="px-3 py-2 text-center text-xs text-zinc-500 uppercase tracking-widest font-normal">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900">
                  {isLoading ? (
                    Array.from({ length: 4 }).map((_, i) => <LoadingRow key={i} cols={7} />)
                  ) : opportunities.length === 0 ? (
                    <EmptyRow cols={7} message="No opportunities detected yet" />
                  ) : (
                    opportunities.map((opp) => (
                      <tr key={opp.id} className="trade-row transition-colors">
                        <td className="px-3 py-2 text-zinc-400 whitespace-nowrap tabular-nums">
                          {formatTime(opp.created_at)}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <BotBadge bot={opp.bot} />
                        </td>
                        <td className="px-3 py-2 text-zinc-300 whitespace-nowrap text-xs">
                          {formatPath(opp.token_in, opp.token_mid, opp.token_out)}
                        </td>
                        <td className="px-3 py-2 text-right text-zinc-400 tabular-nums whitespace-nowrap">
                          {formatBps(opp.score_bps)}
                        </td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums font-semibold whitespace-nowrap ${
                            opp.expected_profit_usdc > 0 ? 'text-emerald-400' : 'text-zinc-400'
                          }`}
                        >
                          {formatUSDC(opp.expected_profit_usdc)}
                        </td>
                        <td className="px-3 py-2 text-right text-zinc-300 tabular-nums whitespace-nowrap">
                          {formatUSDC(opp.amount_in_usdc)}
                        </td>
                        <td className="px-3 py-2 text-center whitespace-nowrap">
                          <StatusBadge status={opp.status} />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ── Footer ── */}
        <footer className="flex items-center justify-between text-xs text-zinc-700 pt-2 pb-4 border-t border-zinc-900">
          <span>MEV Arbitrage Dashboard — Base Network</span>
          <span>apex + go bots</span>
        </footer>

      </div>
    </main>
  );
}
