import { ethers } from 'ethers';
import { createHash } from 'crypto';

// cbETH contract on Base — exchangeRate() returns 1e18-scaled ETH per cbETH
const CBETH_ADDRESS  = '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22';
const WETH_ADDRESS   = '0x4200000000000000000000000000000000000006';
const CBETH_ABI      = ['function exchangeRate() external view returns (uint256)'];

// Uniswap V3 quoter on Base
const QUOTER_ADDRESS = '0x3d4e44Eb1374240CE5F1B136cf68A4f7C49a5bBf';
const QUOTER_ABI     = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

// cbETH/WETH pool fee tiers to try (in order of liquidity depth on Base)
const FEE_TIERS = [500, 100, 3000] as const;

// $10K USDC equivalent in WETH terms (~3.33 WETH at $3K ETH) — representative trade size
const PROBE_AMOUNT_ETH = ethers.parseEther('3.33');

export interface CbEthSignal {
  timestamp:           string;
  blockNumber:         bigint;
  rpcLatencyMs:        number;
  exchangeRateRaw:     bigint;   // raw 1e18 value from contract
  fairCbEthPerWeth:    string;   // how many cbETH per 1 WETH at fair value
  fairWethPerCbEth:    string;   // how many WETH per 1 cbETH at fair value
  dexWethPerCbEth:     string;   // what the DEX quotes for WETH per cbETH
  feeTierUsed:         number;
  grossEdgeBps:        number;
  gasEstimateEth:      string;
  slippageBps:         number;
  dexFeeBps:           number;
  flashLoanFeeBps:     number;
  safetyBufferBps:     number;
  revertRiskBps:       number;
  netEdgeBps:          number;
  opportunity:         boolean;
  reason:              string;
  opportunityHash:     string;
  dryRun:              true;
  allowLive:           false;
}

export interface CbEthEngineConfig {
  minNetEdgeBps:      number;   // default 5 — don't log as opportunity below this
  safetyBufferBps:    number;   // default 10
  revertRiskBps:      number;   // default 5
  slippageBps:        number;   // default 5
  botId:              string;
  strategyId:         string;
}

const DEFAULTS: CbEthEngineConfig = {
  minNetEdgeBps:   5,
  safetyBufferBps: 10,
  revertRiskBps:   5,
  slippageBps:     5,
  botId:           'apex-predator',
  strategyId:      'cbeth_fair_value_base',
};

export class CbEthFairValueEngine {
  private cbeth:  ethers.Contract;
  private quoter: ethers.Contract;
  private cfg:    CbEthEngineConfig;

  constructor(provider: ethers.Provider, cfg: Partial<CbEthEngineConfig> = {}) {
    this.cbeth  = new ethers.Contract(CBETH_ADDRESS, CBETH_ABI, provider);
    this.quoter = new ethers.Contract(QUOTER_ADDRESS, QUOTER_ABI, provider);
    this.cfg    = { ...DEFAULTS, ...cfg };
  }

  async scan(provider: ethers.Provider): Promise<CbEthSignal | null> {
    const t0 = Date.now();

    let blockNumber: bigint;
    let exchangeRateRaw: bigint;

    try {
      [blockNumber, exchangeRateRaw] = await Promise.all([
        provider.getBlockNumber().then(BigInt),
        this.cbeth.exchangeRate() as Promise<bigint>,
      ]);
    } catch (err) {
      console.error('[cbETH] RPC read failed:', err);
      return null;
    }

    const rpcLatencyMs = Date.now() - t0;

    // Fair value: exchangeRate() = (WETH wei per 1 cbETH) × 1e18 baseline
    // So 1 cbETH = exchangeRateRaw / 1e18 WETH
    const fairWethPerCbEth = Number(exchangeRateRaw) / 1e18;
    const fairCbEthPerWeth = 1 / fairWethPerCbEth;

    // Query DEX — try fee tiers until we get a quote
    let dexWethOut: bigint | null = null;
    let feeTierUsed = 0;

    for (const fee of FEE_TIERS) {
      try {
        const [amountOut] = await this.quoter.quoteExactInputSingle.staticCall({
          tokenIn:           CBETH_ADDRESS,
          tokenOut:          WETH_ADDRESS,
          amountIn:          PROBE_AMOUNT_ETH,
          fee,
          sqrtPriceLimitX96: 0n,
        });
        dexWethOut   = amountOut as bigint;
        feeTierUsed  = fee;
        break;
      } catch {
        continue;
      }
    }

    if (dexWethOut === null) {
      console.warn('[cbETH] No DEX quote available — skipping block');
      return null;
    }

    // DEX price: how much WETH we get per cbETH (using probe amount)
    const dexWethPerCbEth = Number(dexWethOut) / Number(PROBE_AMOUNT_ETH);

    // Gross edge in bps: (dex - fair) / fair × 10000
    const grossEdgeBps = ((dexWethPerCbEth - fairWethPerCbEth) / fairWethPerCbEth) * 10_000;

    // Gas estimate — Base L2 is cheap, ~100k gas at ~0.002 gwei ≈ 0.0002 ETH max
    // Convert to bps against probe size (~3.33 ETH probe)
    const gasEstimateEth = '0.0003'; // conservative estimate
    const gasAsBps       = (0.0003 / Number(PROBE_AMOUNT_ETH) * 1e18) * 10_000;

    // Net edge = gross - all costs
    const netEdgeBps =
      grossEdgeBps
      - gasAsBps
      - this.cfg.slippageBps
      - (feeTierUsed / 100)        // DEX fee in bps (500 → 5bps, 100 → 1bps)
      - 0                          // Balancer flash loan: 0% fee
      - this.cfg.safetyBufferBps
      - this.cfg.revertRiskBps;

    const opportunity = netEdgeBps >= this.cfg.minNetEdgeBps;

    const reason = opportunity
      ? `Net edge ${netEdgeBps.toFixed(2)}bps above threshold`
      : grossEdgeBps <= 0
        ? `No gross edge (dex tracks fair value)`
        : `Net edge ${netEdgeBps.toFixed(2)}bps below threshold after costs`;

    // Deterministic opportunity hash for dedup
    const hashInput = [
      8453,
      blockNumber.toString(),
      this.cfg.strategyId,
      'cbETH/WETH',
      feeTierUsed,
      exchangeRateRaw.toString(),
      dexWethOut.toString(),
    ].join('|');
    const opportunityHash = createHash('sha256').update(hashInput).digest('hex').slice(0, 16);

    return {
      timestamp:        new Date().toISOString(),
      blockNumber,
      rpcLatencyMs,
      exchangeRateRaw,
      fairCbEthPerWeth: fairCbEthPerWeth.toFixed(8),
      fairWethPerCbEth: fairWethPerCbEth.toFixed(8),
      dexWethPerCbEth:  dexWethPerCbEth.toFixed(8),
      feeTierUsed,
      grossEdgeBps:     parseFloat(grossEdgeBps.toFixed(4)),
      gasEstimateEth,
      slippageBps:      this.cfg.slippageBps,
      dexFeeBps:        feeTierUsed / 100,
      flashLoanFeeBps:  0,
      safetyBufferBps:  this.cfg.safetyBufferBps,
      revertRiskBps:    this.cfg.revertRiskBps,
      netEdgeBps:       parseFloat(netEdgeBps.toFixed(4)),
      opportunity,
      reason,
      opportunityHash,
      dryRun:           true,
      allowLive:        false,
    };
  }
}
