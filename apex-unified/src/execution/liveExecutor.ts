import { ethers }             from 'ethers';
import { ExecutionPlan }      from '../types/ExecutionPlan';
import { requireLiveAllowed } from '../core/safety';
import CONFIG                 from '../core/config';
import { logger }             from '../core/logger';
import { FastPathExecutor }   from './FastPathExecutor';
import { captureSubmitted, captureResolved } from '../core/captureTelemetry';

const APEX_ABI = [
  'function executeArbitrage(address flashToken, uint256 flashAmount, address uniV3Router, bytes calldata path, uint256 minAmountOut) external',
];

// 1e18 / 3000 — approximates $1 → wei at $3000/ETH, good enough for priority-bid sizing
const USD_TO_WEI_AT_3K = 333_333_333_333_333n;

// NOT_INCLUDED: nonce unconsumed after ~6 blocks (12s on Base)
const INCLUSION_TIMEOUT_MS = 12_000;

// ArbitrageExecuted(address indexed,uint256,uint256,uint256) — parse actual profit
const ARBITRAGE_EXECUTED_TOPIC = ethers.id('ArbitrageExecuted(address,uint256,uint256,uint256)');

export interface LiveResult {
  success:  boolean;
  txHash:   string | null;
  builder:  string;
  error:    string | null;
}

export async function executeLive(
  plan:     ExecutionPlan,
  wallet:   ethers.Wallet,
  provider: ethers.Provider,
  executor?: FastPathExecutor | null,
): Promise<LiveResult> {
  requireLiveAllowed();

  // ── Fast path ──────────────────────────────────────────────────────────────
  // Bypasses populateTransaction, getTransactionCount, and estimateGas round-trips.
  // Dual-broadcasts to Alchemy + sequencer; first accepted hash wins.
  const oppId = plan.opportunity.opportunityHash;

  if (executor) {
    const args = [
      plan.loanToken,
      BigInt(plan.loanAmount),
      plan.routerAddress,
      plan.route,
      BigInt(plan.minAmountOut),
    ];
    // Convert profit to wei with micro-dollar precision to avoid rounding sub-$1 profits to zero
    const profitWei = BigInt(Math.round(plan.estimatedProfitUsd * 1_000_000)) * (USD_TO_WEI_AT_3K / 1_000_000n);
    try {
      const hash = await executor.execute('executeArbitrage', args, profitWei);
      if (hash) {
        captureSubmitted({ opportunityId: oppId, txHash: hash, gasPrice: '0', priorityFee: '0', nonce: 0 });
        // Fast path: no receipt access — resolve as LANDED_PROFIT on success (simulation already passed)
        captureResolved({ opportunityId: oppId, outcome: 'LANDED_PROFIT', inclusionBlock: null, blocksElapsed: null, actualGrossUsd: null, actualNetUsd: null });
        return { success: true, txHash: hash, builder: 'fast-path', error: null };
      }
      captureResolved({ opportunityId: oppId, outcome: 'ERROR', inclusionBlock: null, blocksElapsed: null, actualGrossUsd: null, actualNetUsd: null });
      return { success: false, txHash: null, builder: 'none', error: 'executor returned null' };
    } catch (err: any) {
      logger.error('LIVE', `FastPath failed: ${err.message}`);
      captureResolved({ opportunityId: oppId, outcome: 'ERROR', inclusionBlock: null, blocksElapsed: null, actualGrossUsd: null, actualNetUsd: null });
      return { success: false, txHash: null, builder: 'none', error: err.message };
    }
  }

  // ── Slow path (fallback) ───────────────────────────────────────────────────
  const contract = new ethers.Contract(
    CONFIG.CONTRACTS.APEX_FLASH_LOAN,
    APEX_ABI,
    wallet,
  );

  try {
    // Simulate first — abort if the call would revert, saving gas
    try {
      await contract.executeArbitrage.staticCall(
        plan.loanToken,
        BigInt(plan.loanAmount),
        plan.routerAddress,
        plan.route,
        BigInt(plan.minAmountOut),
        { from: wallet.address },
      );
    } catch (simErr: any) {
      logger.warn('LIVE', `Simulation reverted — skipping broadcast: ${simErr.message}`);
      return { success: false, txHash: null, builder: 'none', error: `simulation reverted: ${simErr.message}` };
    }

    const tx = await contract.executeArbitrage.populateTransaction(
      plan.loanToken,
      BigInt(plan.loanAmount),
      plan.routerAddress,
      plan.route,
      BigInt(plan.minAmountOut),
    );

    tx.gasLimit             = BigInt(plan.gasLimit);
    tx.maxFeePerGas         = BigInt(plan.maxFeePerGas);
    tx.maxPriorityFeePerGas = BigInt(plan.maxPriorityFeePerGas);
    // 'pending' avoids nonce collisions when a previous tx is still in the mempool
    tx.nonce                = await provider.getTransactionCount(wallet.address, 'pending');
    tx.chainId              = BigInt(plan.opportunity.chainId);

    const signed   = await wallet.signTransaction(tx);
    logger.info('LIVE', `Submitting tx for block ${plan.targetBlock}`);

    const response = await provider.broadcastTransaction(signed);
    captureSubmitted({
      opportunityId: oppId,
      txHash:        response.hash,
      gasPrice:      (tx.maxFeePerGas ?? 0n).toString(),
      priorityFee:   (tx.maxPriorityFeePerGas ?? 0n).toString(),
      nonce:         tx.nonce ?? 0,
    });

    const receipt = await Promise.race([
      response.wait(1),
      new Promise<null>(resolve => setTimeout(() => resolve(null), INCLUSION_TIMEOUT_MS)),
    ]);

    if (receipt === null) {
      captureResolved({ opportunityId: oppId, outcome: 'NOT_INCLUDED', inclusionBlock: null, blocksElapsed: null, actualGrossUsd: null, actualNetUsd: null });
      return { success: false, txHash: response.hash, builder: 'direct', error: 'NOT_INCLUDED' };
    }

    if (!receipt || receipt.status === 0) {
      captureResolved({ opportunityId: oppId, outcome: 'REVERTED', inclusionBlock: receipt?.blockNumber ?? null, blocksElapsed: null, actualGrossUsd: null, actualNetUsd: null });
      return { success: false, txHash: response.hash, builder: 'direct', error: 'tx reverted' };
    }

    // Parse actual profit from ArbitrageExecuted(token, amountIn, profit, taxAmount)
    // Profit is in flash token units: USDC=6 dec, WETH=18 dec
    const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
    const isWethLoan   = plan.loanToken.toLowerCase() === WETH_ADDRESS.toLowerCase();
    const ethPriceUsd6 = BigInt(plan.ethPriceUsd6);
    let actualGrossUsd: number | null = null;
    for (const log of receipt.logs) {
      if (log.topics[0] === ARBITRAGE_EXECUTED_TOPIC) {
        try {
          const decoded  = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256', 'uint256'], log.data);
          const profitRaw = decoded[1] as bigint;
          actualGrossUsd = isWethLoan
            ? Number(profitRaw * ethPriceUsd6 / 10n ** 18n) / 1e6   // wei → USD via ETH price
            : Number(profitRaw) / 1e6;                                // USDC base units → USD
        } catch {}
        break;
      }
    }
    const blocksElapsed = receipt.blockNumber - (plan.targetBlock - 1);
    captureResolved({ opportunityId: oppId, outcome: 'LANDED_PROFIT', inclusionBlock: receipt.blockNumber, blocksElapsed, actualGrossUsd, actualNetUsd: actualGrossUsd });

    return { success: true, txHash: receipt.hash, builder: 'direct', error: null };
  } catch (err: any) {
    logger.error('LIVE', `Execution failed: ${err.message}`);
    captureResolved({ opportunityId: oppId, outcome: 'ERROR', inclusionBlock: null, blocksElapsed: null, actualGrossUsd: null, actualNetUsd: null });
    return { success: false, txHash: null, builder: 'none', error: err.message };
  }
}
