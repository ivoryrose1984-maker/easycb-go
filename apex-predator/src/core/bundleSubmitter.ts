// src/core/bundleSubmitter.ts
import { ethers } from 'ethers';
import { FlashbotsBundleProvider, FlashbotsBundleResolution } from '@flashbots/ethers-provider-bundle';
import CONFIG from '../config/constants';
import { logBuilderStats } from '../infrastructure/supabaseLogger';

// ── Shared result types ───────────────────────────────────────────────────────

export interface BundleResult {
  success:           boolean;
  builder:           string;
  txHash?:           string;
  error?:            string;
  simulationResult?: any;
}

export type RawTxSubmitResult = {
  endpoint: string;
  txIndex:  number;
  success:  boolean;
  txHash?:  string;
  error?:   string;
};

// ── Base chain raw tx fanout ──────────────────────────────────────────────────
// Base chain 8453 does not use Ethereum mainnet Flashbots bundle semantics here.
// For Base, we fan out fully signed raw transactions with eth_sendRawTransaction
// to the configured Base builder/RPC endpoints.

type RawTxSubmitParams = {
  signedTxs:  string[];
  endpoints:  string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?:    Pick<Console, 'log' | 'warn' | 'error'>;
};

function dedupeSignedTxs(signedTxs: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const raw of signedTxs) {
    const tx = raw.trim();
    if (!seen.has(tx)) { seen.add(tx); deduped.push(tx); }
  }
  return deduped;
}

function validateRawTxSubmitInput(signedTxs: string[], endpoints: string[]): string[] {
  if (!Array.isArray(signedTxs) || signedTxs.length === 0) {
    throw new Error('signedTxs must be a non-empty array');
  }
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    throw new Error('Base raw transaction endpoints must be a non-empty array');
  }
  const deduped = dedupeSignedTxs(signedTxs);
  for (const tx of deduped) {
    if (typeof tx !== 'string' || tx.length === 0 || !tx.startsWith('0x')) {
      throw new Error(`Invalid signed raw transaction hex: ${String(tx).slice(0, 16)}...`);
    }
  }
  return deduped;
}

export async function submitRawTransactionsToBase({
  signedTxs,
  endpoints,
  timeoutMs = 2500,
  fetchImpl = fetch,
  logger = console,
}: RawTxSubmitParams): Promise<RawTxSubmitResult[]> {
  const uniqueSignedTxs = validateRawTxSubmitInput(signedTxs, endpoints);

  const jobs = uniqueSignedTxs.flatMap((signedTx, txIndex) =>
    endpoints.map(async (endpoint): Promise<RawTxSubmitResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method:  'POST',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify({
            jsonrpc: '2.0',
            id:      1,
            method:  'eth_sendRawTransaction',
            params:  [signedTx],
          }),
          signal: controller.signal,
        });

        let json: any;
        try {
          json = await response.json();
        } catch {
          const message = `Non-JSON RPC response from endpoint=${endpoint} status=${response.status}`;
          logger.warn(`[base-raw-submit] ${message}`);
          return { endpoint, txIndex, success: false, error: message };
        }

        if (json.error) {
          const message = typeof json.error === 'string'
            ? json.error
            : (json.error.message ?? JSON.stringify(json.error));
          logger.warn(`[base-raw-submit] rejected endpoint=${endpoint} txIndex=${txIndex} error=${message}`);
          return { endpoint, txIndex, success: false, error: message };
        }

        if (typeof json.result !== 'string' || !json.result.startsWith('0x')) {
          const message = `Invalid RPC result from endpoint=${endpoint}: ${JSON.stringify(json.result)}`;
          logger.warn(`[base-raw-submit] ${message}`);
          return { endpoint, txIndex, success: false, error: message };
        }

        logger.log(`[base-raw-submit] accepted endpoint=${endpoint} txIndex=${txIndex} txHash=${json.result}`);
        return { endpoint, txIndex, success: true, txHash: json.result };

      } catch (err) {
        const isAbort = err instanceof Error && err.name === 'AbortError';
        const message = isAbort
          ? `timeout after ${timeoutMs}ms`
          : err instanceof Error ? err.message : String(err);
        logger.error(`[base-raw-submit] failed endpoint=${endpoint} txIndex=${txIndex} error=${message}`);
        return { endpoint, txIndex, success: false, error: message };
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const settled = await Promise.allSettled(jobs);
  return settled.map((item): RawTxSubmitResult => {
    if (item.status === 'fulfilled') return item.value;
    return {
      endpoint: 'unknown',
      txIndex:  -1,
      success:  false,
      error:    item.reason instanceof Error ? item.reason.message : String(item.reason),
    };
  });
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function submitBundleWithFailover(
  signedTx:          string,
  targetBlockNumber: number,
  wallet:            ethers.Wallet,
  provider:          ethers.Provider,
): Promise<BundleResult> {

  // Base chain 8453 does not use Ethereum mainnet Flashbots bundle semantics here.
  // For Base, we fan out fully signed raw transactions with eth_sendRawTransaction
  // to the configured Base builder/RPC endpoints.
  if (CONFIG.CHAIN_ID === 8453) {
    const endpoints = CONFIG.BUILDERS.filter(b => b.enabled).map(b => b.url);
    const start = Date.now();
    const results = await submitRawTransactionsToBase({ signedTxs: [signedTx], endpoints });
    const elapsed = Date.now() - start;

    const success = results.find(r => r.success);
    if (success) {
      const builderName = CONFIG.BUILDERS.find(b => b.url === success.endpoint)?.name ?? success.endpoint;
      await logBuilderStats({
        builder_name:     builderName,
        success:          true,
        block_number:     targetBlockNumber,
        response_time_ms: elapsed,
      });
      return { success: true, builder: builderName, txHash: success.txHash };
    }

    const errors = results.map(r => r.error).filter(Boolean).join('; ');
    await logBuilderStats({
      builder_name:     'all_failed',
      success:          false,
      block_number:     targetBlockNumber,
      error_message:    errors,
      response_time_ms: elapsed,
    });
    return { success: false, builder: 'all_failed', error: errors };
  }

  // ── Non-Base chains: existing Flashbots bundle path ───────────────────────
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
        block_number: targetBlockNumber,
        error_message: `Not included: ${resolutionName}`,
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
