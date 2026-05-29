import { ethers }               from 'ethers';
import { createHash }            from 'crypto';
import { TOKENS, CONTRACTS, CBETH_ABI, QUOTER_ABI } from '../../config/tokens';
import { computeProfitability }  from '../../risk/ProfitabilityEngine';
import { getCexFeed }            from '../cex/BinanceFeed';
import { getCompetitionWindow, adjustedThreshold } from '../cex/TimeOfDayMultiplier';
import { ENV }                   from '../../config/env';

// ~3.33 ETH probe — representative $10K at $3K/ETH
const PROBE_WETH = ethers.parseEther('3.33');

// Fee tiers to try: 0.05%, 0.01%, 0.3%
const FEE_TIERS = [500, 100, 3000] as const;

export interface GrokSignal {
  // Identity
  timestamp:        string;
  bot_id:           string;
  strategy_id:      string;
  run_id:           string;
  chain_id:         8453;

  // Chain state
  block_number:     string;
  rpc_latency_ms:   number;

  // cbETH fair value
  exchange_rate_raw: string;
  fair_weth_per_cbeth: string;

  // DEX
  dex_weth_per_cbeth:  string;
  fee_tier_used:       number;

  // CEX signal
  cex_eth_mid:         number | null;
  cex_divergence_bps:  number | null;
  cex_triggered:       boolean;

  // Competition window
  competition_label:   string;
  competition_multiplier: number;
  effective_threshold_bps: number;

  // Profitability
  gross_edge_bps:      number;
  net_edge_bps:        number;
  gas_estimate_eth:    string;
  slippage_bps:        number;
  dex_fee_bps:         number;
  flash_loan_fee_bps:  number;
  safety_buffer_bps:   number;
  revert_risk_bps:     number;

  // Decision
  opportunity:         boolean;
  opportunity_hash:    string;
  reason:              string;

  // Safety — always hardcoded
  dry_run:             true;
  allow_live:          false;
}

export class CbEthEngine {
  private cbeth:  ethers.Contract;
  private quoter: ethers.Contract;

  constructor(provider: ethers.Provider) {
    this.cbeth  = new ethers.Contract(TOKENS.cbETH, CBETH_ABI, provider);
    this.quoter = new ethers.Contract(CONTRACTS.UNISWAP_V3_QUOTER, QUOTER_ABI, provider);
  }

  async scan(provider: ethers.Provider): Promise<GrokSignal | null> {
    const t0 = Date.now();

    // 1. Read chain state + cbETH rate in one round trip
    let blockNumber:     bigint;
    let exchangeRateRaw: bigint;
    try {
      [blockNumber, exchangeRateRaw] = await Promise.all([
        provider.getBlockNumber().then(BigInt),
        this.cbeth.exchangeRate() as Promise<bigint>,
      ]);
    } catch (err) {
      console.error('[GrokBot] RPC failed:', (err as Error).message);
      return null;
    }

    const rpcLatencyMs   = Date.now() - t0;
    const fairWethPerCbEth = Number(exchangeRateRaw) / 1e18;

    // 2. DEX quote — try fee tiers
    let dexWethOut: bigint | null = null;
    let feeTierUsed = 0;

    for (const fee of FEE_TIERS) {
      try {
        const [amountOut] = await this.quoter.quoteExactInputSingle.staticCall({
          tokenIn:           TOKENS.cbETH,
          tokenOut:          TOKENS.WETH,
          amountIn:          PROBE_WETH,
          fee,
          sqrtPriceLimitX96: 0n,
        });
        dexWethOut  = amountOut as bigint;
        feeTierUsed = fee;
        break;
      } catch { continue; }
    }

    if (dexWethOut === null) {
      console.warn('[GrokBot] No DEX quote — skipping block');
      return null;
    }

    const dexWethPerCbEth = Number(dexWethOut) / Number(PROBE_WETH);
    const grossEdgeBps    = ((dexWethPerCbEth - fairWethPerCbEth) / fairWethPerCbEth) * 10_000;

    // 3. CEX signal — Binance ETH/USDC mid price
    const cex           = getCexFeed();
    const cexEthMid     = cex.getMid('ethusdc');
    const cexDivBps     = cexEthMid !== null ? cex.getDivergenceBps('ethusdc', dexWethPerCbEth / fairWethPerCbEth * cexEthMid) : null;
    const cexTriggered  = cexDivBps !== null && Math.abs(cexDivBps) >= ENV.CEX_TRIGGER_BPS;

    // 4. Competition window
    const window           = getCompetitionWindow();
    const effectiveThresh  = adjustedThreshold(ENV.MIN_NET_EDGE_BPS);

    // 5. Profitability
    const probeSizeEth = Number(ethers.formatEther(PROBE_WETH));
    const profit = computeProfitability(grossEdgeBps, probeSizeEth, {
      dexFeeBps: feeTierUsed / 100,
    }, effectiveThresh);

    // 6. Opportunity hash
    const hashInput = [
      ENV.CHAIN_ID,
      blockNumber.toString(),
      ENV.STRATEGY_ID,
      feeTierUsed,
      exchangeRateRaw.toString(),
      dexWethOut.toString(),
    ].join('|');
    const opportunityHash = createHash('sha256').update(hashInput).digest('hex').slice(0, 16);

    return {
      timestamp:                new Date().toISOString(),
      bot_id:                   ENV.BOT_ID,
      strategy_id:              ENV.STRATEGY_ID,
      run_id:                   ENV.RUN_ID,
      chain_id:                 8453,
      block_number:             blockNumber.toString(),
      rpc_latency_ms:           rpcLatencyMs,
      exchange_rate_raw:        exchangeRateRaw.toString(),
      fair_weth_per_cbeth:      fairWethPerCbEth.toFixed(8),
      dex_weth_per_cbeth:       dexWethPerCbEth.toFixed(8),
      fee_tier_used:            feeTierUsed,
      cex_eth_mid:              cexEthMid,
      cex_divergence_bps:       cexDivBps !== null ? parseFloat(cexDivBps.toFixed(4)) : null,
      cex_triggered:            cexTriggered,
      competition_label:        window.label,
      competition_multiplier:   window.multiplier,
      effective_threshold_bps:  parseFloat(effectiveThresh.toFixed(2)),
      gross_edge_bps:           parseFloat(grossEdgeBps.toFixed(4)),
      net_edge_bps:             profit.netEdgeBps,
      gas_estimate_eth:         profit.estimatedGasEth,
      slippage_bps:             5,
      dex_fee_bps:              feeTierUsed / 100,
      flash_loan_fee_bps:       0,
      safety_buffer_bps:        10,
      revert_risk_bps:          5,
      opportunity:              profit.profitable,
      opportunity_hash:         opportunityHash,
      reason:                   profit.reason,
      dry_run:                  true,
      allow_live:               false,
    };
  }
}
