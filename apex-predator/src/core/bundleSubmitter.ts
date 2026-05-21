// src/core/bundleSubmitter.ts
import { ethers } from 'ethers';
import { FlashbotsBundleProvider, FlashbotsBundleResolution } from '@flashbots/ethers-provider-bundle';
import CONFIG from '../config/constants';
import { logBuilderStats } from '../infrastructure/supabaseLogger';

interface BundleResult {
  success:          boolean;
  builder:          string;
  txHash?:          string;
  error?:           string;
  simulationResult?: any;
}

export async function submitBundleWithFailover(
  signedTx:          string,
  targetBlockNumber: number,
  wallet:            ethers.Wallet,
  provider:          ethers.Provider
): Promise<BundleResult> {

  const builders = CONFIG.BUILDERS.filter(b => b.enabled);
  if (builders.length === 0) {
    return { success: false, builder: 'none', error: 'No builders enabled' };
  }

  for (const builder of builders) {
    const startTime = Date.now();
    try {
      console.log(`[BUNDLE] Trying ${builder.name} for block ${targetBlockNumber}...`);

      const flashbotsProvider = await FlashbotsBundleProvider.create(
        provider, wallet, builder.url
      );

      const signedBundle = [signedTx];
      const simulation   = await flashbotsProvider.simulate(signedBundle, targetBlockNumber);

      if ('error' in simulation) {
        console.warn(`[BUNDLE] ${builder.name} sim failed:`, simulation.error.message);
        await logBuilderStats({
          builder_name: builder.name, success: false,
          block_number: targetBlockNumber, error_message: simulation.error.message,
          response_time_ms: Date.now() - startTime,
        });
        continue;
      }

      if (simulation.firstRevert) {
        console.warn(`[BUNDLE] ${builder.name} sim reverted:`, simulation.firstRevert);
        await logBuilderStats({
          builder_name: builder.name, success: false,
          block_number: targetBlockNumber, error_message: 'Simulation reverted',
          response_time_ms: Date.now() - startTime,
        });
        continue;
      }

      // Guard against zero-gas simulations (indicates something is wrong)
      if (!simulation.totalGasUsed || simulation.totalGasUsed === 0) {
        console.warn(`[BUNDLE] ${builder.name} sim returned 0 gas - skipping`);
        await logBuilderStats({
          builder_name: builder.name, success: false,
          block_number: targetBlockNumber, error_message: 'Zero gas in simulation',
          response_time_ms: Date.now() - startTime,
        });
        continue;
      }

      console.log(`[BUNDLE] ✅ ${builder.name} simulation succeeded`);

      const bundleSubmission = await flashbotsProvider.sendRawBundle(signedBundle, targetBlockNumber);
      if ('error' in bundleSubmission) {
        console.warn(`[BUNDLE] ${builder.name} submission failed:`, bundleSubmission.error.message);
        await logBuilderStats({
          builder_name: builder.name, success: false,
          block_number: targetBlockNumber, error_message: bundleSubmission.error.message,
          response_time_ms: Date.now() - startTime,
        });
        continue;
      }

      console.log(`[BUNDLE] 📤 Submitted to ${builder.name}, waiting...`);
      const waitResponse = await bundleSubmission.wait();

      // FlashbotsBundleResolution: 0=BundleIncluded, 1=BlockPassedWithoutInclusion, 2=AccountNonceTooHigh
      if (waitResponse === FlashbotsBundleResolution.BundleIncluded) {
        console.log(`[BUNDLE] ✅ ${builder.name} INCLUDED in block ${targetBlockNumber}`);
        await logBuilderStats({
          builder_name: builder.name, success: true,
          block_number: targetBlockNumber,
          response_time_ms: Date.now() - startTime,
        });
        return { success: true, builder: builder.name, simulationResult: simulation };
      }

      const resolutionName = FlashbotsBundleResolution[waitResponse] ?? String(waitResponse);
      console.warn(`[BUNDLE] ${builder.name} not included: ${resolutionName}`);
      await logBuilderStats({
        builder_name: builder.name, success: false,
        block_number: targetBlockNumber, error_message: `Not included: ${FlashbotsBundleResolution[waitResponse] ?? waitResponse}`,
        response_time_ms: Date.now() - startTime,
      });

    } catch (error: any) {
      console.error(`[BUNDLE] ${builder.name} error:`, error.message);
      await logBuilderStats({
        builder_name: builder.name, success: false,
        block_number: targetBlockNumber, error_message: error.message,
        response_time_ms: Date.now() - startTime,
      });
    }
  }

  return { success: false, builder: 'all_failed', error: `All ${builders.length} builders failed` };
}

export default submitBundleWithFailover;
