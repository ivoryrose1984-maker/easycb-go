/**
 * FastPathExecutor — apex-unified detection→submission latency cut
 * ==================================================================
 * Goal: collapse ~300–500ms of per-trade RPC round-trips down to ~50ms
 * (one network call: the broadcast itself), while KEEPING priority-fee
 * bidding — Base (OP Stack) orders transactions by priority fee, with
 * Flashblocks (~200ms sub-blocks) making arrival time the tiebreaker.
 * Both levers matter. This module optimizes both.
 *
 * What it removes from the hot path:
 *   ✗ populateTransaction        -> calldata encoded locally, no RPC
 *   ✗ getTransactionCount        -> nonce tracked in memory
 *   ✗ getFeeData per trade       -> fee fields cached per block
 *   ✗ estimateGas per trade      -> fixed gas limit per route (profiled)
 *
 * What it adds:
 *   ✓ Priority-fee bid computed locally from expected profit
 *   ✓ Dual simultaneous broadcast: Alchemy + Base sequencer endpoint
 *   ✓ DRY_RUN gate (never broadcasts unless both gates open)
 *
 * Wiring:
 *   const exec = new FastPathExecutor({ wallet?, primaryRpc, sequencerRpc, chainId, contract, abi });
 *   await exec.init();                   // one-time nonce + fee seed
 *   rws.on('block', bn => exec.onBlock(bn)); // feeds the fee cache
 *   const hash = await exec.execute('executeArbitrage', args, expectedProfitWei);
 */

import {
  Wallet,
  Interface,
  JsonRpcProvider,
  Transaction,
  TransactionLike,
} from 'ethers';
import { logger } from '../core/logger';

export interface FastPathConfig {
  wallet?:      Wallet;    // optional — not needed for dry-run fee-cache warming
  primaryRpc:   string;    // Alchemy HTTPS endpoint
  sequencerRpc: string;    // https://mainnet.base.org — direct to sequencer
  chainId:      number;    // 8453
  contract:     string;    // ApexFlashLoan contract address
  abi:          string[];  // human-readable ABI fragment(s)
  gasLimit?:    bigint;    // per-route fixed limit; default 600k
}

const DEFAULTS = {
  GAS_LIMIT:           600_000n,
  PRIORITY_SCALE_BPS:  1_500n,       // bid 15% of expected profit as priority fee
  PRIORITY_FLOOR_WEI:  1_000_000n,   // 0.001 gwei floor — Base fees are tiny vs L1
  BASE_FEE_BUFFER:     2n,           // maxFeePerGas = baseFee × 2 + priority
  FEE_FALLBACK_WEI:    1_000_000_000n, // 1 gwei fallback when cache is cold
};

export class FastPathExecutor {
  private readonly wallet:     Wallet | undefined;
  private readonly gasLimit:   bigint;
  private readonly contract:   string;
  private readonly chainId:    number;
  private readonly iface:      Interface;
  private readonly primary:    JsonRpcProvider;
  private readonly sequencer:  JsonRpcProvider;

  private nonce    = -1;
  private feeCache = { baseFeeWei: DEFAULTS.FEE_FALLBACK_WEI, blockNumber: 0 };

  constructor(cfg: FastPathConfig) {
    this.wallet    = cfg.wallet;
    this.gasLimit  = cfg.gasLimit ?? DEFAULTS.GAS_LIMIT;
    this.contract  = cfg.contract;
    this.chainId   = cfg.chainId;
    this.iface     = new Interface(cfg.abi);
    this.primary   = new JsonRpcProvider(cfg.primaryRpc,   cfg.chainId, { staticNetwork: true });
    this.sequencer = new JsonRpcProvider(cfg.sequencerRpc, cfg.chainId, { staticNetwork: true });
  }

  /** One-time boot: seed nonce (if wallet provided) + initial fee data. */
  async init(): Promise<void> {
    if (this.wallet) {
      this.nonce = await this.primary.getTransactionCount(this.wallet.address, 'pending');
    }
    await this.refreshFees();
    logger.info('FPX', `initialized — nonce=${this.nonce} baseFee=${this.feeCache.baseFeeWei}wei`);
  }

  /**
   * Call from the block listener — ONE fee refresh per block, never per trade.
   * Fire-and-forget; the hot path reads the cache synchronously.
   */
  onBlock(blockNumber: number): void {
    if (blockNumber > this.feeCache.blockNumber) {
      this.feeCache.blockNumber = blockNumber;
      this.refreshFees().catch(() => {});
    }
  }

  private async refreshFees(): Promise<void> {
    const block = await this.primary.getBlock('latest');
    if (block?.baseFeePerGas) this.feeCache.baseFeeWei = block.baseFeePerGas;
  }

  private computeBid(expectedProfitWei: bigint): { priorityFeePerGas: bigint; maxFeePerGas: bigint } {
    const scaled          = (expectedProfitWei * DEFAULTS.PRIORITY_SCALE_BPS) / 10_000n;
    const priorityFeeWei  = scaled < DEFAULTS.PRIORITY_FLOOR_WEI ? DEFAULTS.PRIORITY_FLOOR_WEI : scaled;
    const priorityFeePerGas = priorityFeeWei / this.gasLimit > 0n
      ? priorityFeeWei / this.gasLimit
      : 1n;
    const maxFeePerGas = this.feeCache.baseFeeWei * DEFAULTS.BASE_FEE_BUFFER + priorityFeePerGas;
    return { priorityFeePerGas, maxFeePerGas };
  }

  /**
   * Hot path — synchronous/local until the single broadcast call.
   * @param method           contract function name e.g. "executeArbitrage"
   * @param args             positional arguments for that function
   * @param expectedProfitWei net profit estimate in wei — drives the priority bid
   * @returns tx hash on success, null in DRY_RUN or on failure
   */
  async execute(
    method:            string,
    args:              unknown[],
    expectedProfitWei: bigint,
  ): Promise<string | null> {
    const dryRun    = process.env.DRY_RUN    !== 'false';
    const allowLive = process.env.ALLOW_LIVE === 'true';

    // 1. Local calldata — zero RPC
    const data = this.iface.encodeFunctionData(method, args);

    // 2. Fees from per-block cache — zero RPC
    const { priorityFeePerGas, maxFeePerGas } = this.computeBid(expectedProfitWei);

    // 3. Nonce from memory — zero RPC
    const nonce = this.nonce;

    // Dry-run gate BEFORE signing — wallet key not needed during dry run
    if (dryRun || !allowLive) {
      logger.info('FPX',
        `[DRY_RUN] would broadcast nonce=${nonce} ` +
        `prio=${priorityFeePerGas}wei/gas maxFee=${maxFeePerGas}wei/gas ` +
        `profit=${expectedProfitWei}wei method=${method}`,
      );
      return null; // nonce NOT consumed
    }

    if (!this.wallet) {
      logger.error('FPX', 'No wallet configured — live execution requires WALLET_PRIVATE_KEY');
      return null;
    }

    const txLike: TransactionLike = {
      to:                   this.contract,
      data,
      nonce,
      gasLimit:             this.gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas: priorityFeePerGas,
      chainId:              this.chainId,
      type:                 2,
      value:                0n,
    };

    // 4. Offline signing — zero RPC
    const signed = await this.wallet.signTransaction(Transaction.from(txLike));

    // 5. The only network hop: dual simultaneous broadcast.
    //    Same signed tx, same nonce — duplicate acceptance is fine;
    //    the second path returns "already known". First success wins.
    this.nonce++;
    try {
      const hash = await Promise.any([
        this.broadcast(this.primary,   signed, 'alchemy'),
        this.broadcast(this.sequencer, signed, 'sequencer'),
      ]);
      logger.info('FPX', `broadcast ok ${hash}`);
      return hash;
    } catch (err: any) {
      const msgs = (err?.errors ?? [err]).map((e: any) => String(e?.message ?? e));
      if (msgs.some((m: string) => m.includes('nonce'))) {
        this.nonce = await this.primary.getTransactionCount(this.wallet.address, 'pending');
        logger.warn('FPX', `nonce conflict — resynced to ${this.nonce}`);
      } else {
        this.nonce--;
      }
      logger.error('FPX', `both broadcast paths failed: ${msgs.join(' | ')}`);
      return null;
    }
  }

  private async broadcast(provider: JsonRpcProvider, signedTx: string, label: string): Promise<string> {
    const hash = await provider.send('eth_sendRawTransaction', [signedTx]) as string;
    logger.info('FPX', `accepted via ${label}: ${hash}`);
    return hash;
  }

  /** Hard resync after a confirmed revert or external nonce consumption. */
  async resyncNonce(): Promise<void> {
    if (!this.wallet) return;
    this.nonce = await this.primary.getTransactionCount(this.wallet.address, 'pending');
  }
}

// ── Slippage floor packing ────────────────────────────────────────────────────
// Returns minAmountOut = quote × (1 − slippageBps/10000), enforced on-chain.
// Uses integer multiply + divide — no floating-point, no heap allocation.
//
// Default: 5 bps (0.05%) slippage tolerance.
// Why 5 bps: 2-hop path through concentrated liquidity; typical L2 block latency
// is 2s; 5bps absorbs price drift without over-rejecting profitable bundles.
//
// On-chain revert cost if slippage exceeded: ~3 000 gas (Balancer callback
// fails after exactInput reverts; caught before profit check).
export function packMinAmountOut(quote: bigint, slippageBps = 5n): bigint {
  if (quote === 0n) return 0n;
  if (slippageBps >= 10_000n) return 0n;  // 100% slippage = accept any output
  return quote * (10_000n - slippageBps) / 10_000n;
}

// ── Pre-flight calldata size helper ──────────────────────────────────────────
// Returns the exact byte length of the ABI-encoded executeArbitrageWithPreflight
// calldata given the hop-count of the path (used for gas estimation pre-broadcast).
// path bytes = 20 + (20+3) × hops where single hop = 20+3+20 = 43.
export function preflightCalldataSize(hopCount: number): number {
  const pathBytes = 20 + 23 * hopCount;  // addr + (fee+addr) × hops
  // selector(4) + 8 fixed params × 32 + path offset(32) + path len(32) + path data(padded)
  const pathWords = Math.ceil(pathBytes / 32);
  return 4 + 8 * 32 + 32 + 32 + pathWords * 32;
}
