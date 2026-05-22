/**
 * Format a USDC numeric value (already in dollars) as $X.XX
 */
export function formatUSDC(value: number): string {
  if (value === 0) return '$0.00';
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return value < 0 ? `-$${formatted}` : `$${formatted}`;
}

/**
 * Format a short token symbol — truncate long hex addresses
 */
export function formatToken(address: string): string {
  if (!address) return '???';
  // If it looks like an ETH address, show shortened form
  if (address.startsWith('0x') && address.length === 42) {
    return address.slice(0, 6) + '…' + address.slice(-4);
  }
  return address.toUpperCase();
}

/**
 * Format a trade path as "A → B → C" or "A → B"
 */
export function formatPath(tokenIn: string, tokenMid: string | null, tokenOut: string): string {
  const a = formatToken(tokenIn);
  const c = formatToken(tokenOut);
  if (tokenMid) {
    const b = formatToken(tokenMid);
    return `${a} → ${b} → ${c}`;
  }
  return `${a} → ${c}`;
}

/**
 * Format a timestamp as HH:MM:SS (local time)
 */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour12: false });
}

/**
 * Format a timestamp as MM/DD HH:MM
 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Format win rate as percentage
 */
export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

/**
 * Format score in basis points
 */
export function formatBps(bps: number | null): string {
  if (bps === null || bps === undefined) return '—';
  return `${bps} bps`;
}

/**
 * Format a large number with K/M suffix
 */
export function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}
