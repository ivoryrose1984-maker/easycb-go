import { ethers }             from 'ethers';
import { ExecutionPlan }      from '../types/ExecutionPlan';
import { requireLiveAllowed } from '../core/safety';
import CONFIG                 from '../core/config';
import { logger }             from '../core/logger';
import { FastPathExecutor }   from './FastPathExecutor';

const APEX_ABI = [
  'function executeArbitrage(address flashToken, uint256 flashAmount, address uniV3Router, bytes calldata path, uint256 minAmountOut) external',
];

// 1e18 / 3000 — approximates $1 → wei at $3000/ETH, good enough for priority-bid sizing
const USD_TO_WEI_AT_3K = 333_333_333_333_333n;

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
  if (executor) {
    const args = [
      plan.loanToken,
      BigInt(plan.loanAmount),
      plan.routerAddress,
      plan.route,
      BigInt(plan.minAmountOut),
    ];
    const profitWei = BigInt(Math.round(plan.estimatedProfitUsd)) * USD_TO_WEI_AT_3K;
    try {
      const hash = await executor.execute('executeArbitrage', args, profitWei);
      if (hash) return { success: true,  txHash: hash, builder: 'fast-path', error: null };
      return           { success: false, txHash: null, builder: 'none',      error: 'executor returned null' };
    } catch (err: any) {
      logger.error('LIVE', `FastPath failed: ${err.message}`);
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
    const receipt  = await response.wait(1);

    if (!receipt || receipt.status === 0) {
      return { success: false, txHash: response.hash, builder: 'direct', error: 'tx reverted' };
    }
    return { success: true, txHash: receipt.hash, builder: 'direct', error: null };
  } catch (err: any) {
    logger.error('LIVE', `Execution failed: ${err.message}`);
    return { success: false, txHash: null, builder: 'none', error: err.message };
  }
}
