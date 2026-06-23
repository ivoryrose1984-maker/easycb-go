# CEX Price Feeds Integration Plan

## Purpose

AMM quotes alone describe on-chain state at the moment of the last block. CEX mid-prices (Binance, Coinbase) reflect real-time order-book consensus and lead AMM prices by 200–800 ms on average. Consuming CEX feeds as a pre-filter lets the bot skip expensive RPC quote calls for pairs where the CEX spread is too tight to be worth pursuing, and surface only cycles where an exploitable gap already exists off-chain.

## Trigger Threshold

**15 bps** between the CEX mid-price and the estimated AMM execution price before the bot fires any on-chain quote. Below that threshold the expected net profit after gas + latency/failure buffers (10 bps combined) and Balancer fee (0 bps) does not clear the `MIN_PROFIT_BPS: 20` floor.

## Data Sources

| Exchange | Feed | Pairs |
|----------|------|-------|
| Binance | `wss://stream.binance.com:9443/stream` | ETH/USDC, BTC/USDC, ETH/BTC |
| Coinbase | `wss://advanced-trade-api.coinbase.com` | ETH-USD, BTC-USD, cbBTC-USD, cbETH-USD |

Both sources stream `bestBid` / `bestAsk` at sub-second intervals. Mid-price = `(bid + ask) / 2`.

## Architecture

```
CEX WebSocket thread
  └─ priceCache: Map<symbol, { mid: number; ts: number }>
        ↓ (read-only, no lock needed — single writer)
Block scanner (existing loop)
  └─ for each candidate pair:
       cexMid = priceCache.get(symbol)
       if (!cexMid || Date.now() - cexMid.ts > 5_000) → skip, stale feed
       if abs(ammEstimate - cexMid.mid) / cexMid.mid * 10_000 < 15 → skip
       else → proceed to full on-chain quote + ternary search
```

The cache is a plain in-memory `Map` written by one async WebSocket handler and read by the synchronous scan loop. No mutex required in single-threaded Node.js. The Go bot equivalent uses a `sync/atomic` pointer swap.

## Implementation Phases

### Phase 0 — Dry-run only (build during dry-run)
- Stand up WebSocket connections to Binance and Coinbase with exponential-backoff reconnect (mirrors existing `WSS_BASE_DELAY_MS` / `WSS_MAX_DELAY_MS` parameters).
- Populate `priceCache` but **do not gate any scan logic yet**.
- Log CEX mid vs. first AMM quote for every pair to validate spread correlation.
- Target: 48 h of dry-run logs showing filter would have eliminated ≥40% of quote calls.

### Phase 1 — Pre-filter live (after dry-run validation)
- Add the 15 bps pre-filter gate in `ApexPredator.ts` before the ternary search entry point.
- Add `REJECTION.CEX_SPREAD_TOO_THIN` to `supabaseLogger.ts` and `opportunity_rejections`.
- Monitor `CEX_SPREAD_TOO_THIN` rejection rate; tune threshold if needed.

### Phase 2 — Directional bias (optional, later)
- If CEX price moved >X bps in the last 500 ms, the AMM has not yet repriced. Bias ternary search toward the direction of CEX movement (higher loan in the direction of the arb).
- Requires careful backtesting — do not implement until Phase 1 is validated.

## Environment Variables Required

```
BINANCE_WS_URL=wss://stream.binance.com:9443/stream
COINBASE_WS_URL=wss://advanced-trade-api.coinbase.com
CEX_STALE_MS=5000          # drop feed data older than this
CEX_TRIGGER_BPS=15         # minimum deviation to proceed to on-chain quote
```

No API keys needed — both feeds are public unauthenticated WebSocket streams.

## Risk Controls

- **Stale feed**: If either feed goes silent for >5 s, mark cache stale and let all pairs through (conservative fallback — never block on missing data).
- **Reconnect**: Use the same `WSS_BASE_DELAY_MS` / `WSS_MAX_ATTEMPTS` exponential-backoff already in place for the RPC WebSocket.
- **No order routing to CEX**: This is a read-only feed. The bot never places orders on any centralized exchange.

## Do Not Build Before Dry-Run

CEX feeds are an optimization, not a correctness requirement. The bot is profitable without them. Build and validate during the dry-run window when real gas is not being spent, so the filter threshold can be calibrated against actual on-chain data before it gates live executions.
