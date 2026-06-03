import { ethers }          from 'ethers';
import { ExecutionPlan }   from '../types/ExecutionPlan';
import { requireLiveAllowed } from '../core/safety';
import CONFIG              from '../core/config';
import { logger }          from '../core/logger';

const APEX_ABI = [
  'function executeArbitrage(address flashToken, uint256 flashAmount, address uniV3Router, bytes calldata path, uint256 minAmountOut) external',
];

export interface LiveResult {
  success:  boolean;
  txHash:   string | null;
  builder:  string;
  error:    string | null;
}

export async function executeLive(
  plan:     ExecutionPlan,
  wallet:   ethers.Wallet,
  provider: ethers.Provider
): Promise<LiveResult> {
  requireLiveAllowed();

  const contract = new ethers.Contract(
    CONFIG.CONTRACTS.APEX_FLASH_LOAN,
    APEX_ABI,
    wallet
  );

  try {
    const tx = await contract.executeArbitrage.populateTransaction(
      plan.loanToken,
      BigInt(plan.loanAmount),
      plan.flashLoanSource,
      plan.route,
      BigInt(plan.minAmountOut)
    );

    tx.gasLimit             = BigInt(plan.gasLimit);
    tx.maxFeePerGas         = BigInt(plan.maxFeePerGas);
    tx.maxPriorityFeePerGas = BigInt(plan.maxPriorityFeePerGas);
    tx.nonce                = await provider.getTransactionCount(wallet.address);
    tx.chainId              = BigInt(plan.opportunity.chainId);

    const signed = await wallet.signTransaction(tx);
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
