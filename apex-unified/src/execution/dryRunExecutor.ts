import { Opportunity }       from '../types/Opportunity';
import { logOpportunity }    from '../core/jsonlLogger';
import { logger }            from '../core/logger';
import { sendAlert }         from '../infrastructure/telegramAlert';
import { checkExecutionAllowed } from '../core/safety';
import { getGasForecast }    from './gasForecaster';
import { buildExecutionPlan } from './flashLoanPlanner';
import { executeLive }       from './liveExecutor';
import { checkTradeAllowed } from '../risk/lossLimits';
import { FastPathExecutor }  from './FastPathExecutor';
import CONFIG                from '../core/config';
import { ethers }            from 'ethers';

// Module-level state — set once per (re)connect via setupExecutor()
let _wallet:   ethers.Wallet    | null = null;
let _provider: ethers.Provider  | null = null;
let _fastExec: FastPathExecutor | null = null;
let _ethPrice  = 3_000_000_000n;

export function setupExecutor(
  wallet:   ethers.Wallet    | null,
  provider: ethers.Provider  | null,
  fastExec: FastPathExecutor | null,
  ethPrice: bigint,
): void {
  _wallet   = wallet;
  _provider = provider;
  _fastExec = fastExec;
  _ethPrice = ethPrice;
}

export function updateExecutorEthPrice(price: bigint): void {
  _ethPrice = price;
}

export interface DryRunResult {
  logged:  boolean;
  alerted: boolean;
  hash:    string;
  netBps:  number;
}

export async function executeDryRun(opp: Opportunity): Promise<DryRunResult> {
  logOpportunity(opp);

  logger.info('DRY_RUN',
    `[OPPORTUNITY] strat=${opp.strategyId} hash=${opp.opportunityHash} ` +
    `spread=${opp.spreadBps}bps gross=$${opp.grossProfitUsd.toFixed(2)} ` +
    `live=${opp.liveEligible} block=${opp.blockNumber}`,
  );

  const liveTag = opp.liveEligible ? '[live-eligible]' : '[dry-run-only]';
  sendAlert(
    `Opportunity detected\n` +
    `Strategy: ${opp.strategyId}\n` +
    `Route: ${opp.route}\n` +
    `Spread: ${opp.spreadBps}bps\n` +
    `Block: ${opp.blockNumber}\n` +
    `Hash: ${opp.opportunityHash}\n` +
    liveTag,
  );

  // ── Live execution gate ──────────────────────────────────────────────────
  // This block is unreachable from dry-run.ts (assertDryRunMode blocks it).
  // Reached only from live.ts when DRY_RUN=false, ALLOW_LIVE=true.
  const gate = checkExecutionAllowed();
  if (gate.allowed) {
    if (!opp.liveEligible || !opp.feeBuy || !opp.feeSell || !opp.liveRouterAddress) {
      logger.debug('EXEC', `${opp.opportunityHash} cross-DEX — not live-eligible for single-router contract`);
    } else if (!_wallet || !_provider) {
      logger.error('EXEC', 'Live gate open but wallet/provider not initialised — check WALLET_PRIVATE_KEY');
    } else {
      const isWeth    = opp.tokenIn.toLowerCase() === CONFIG.TOKENS.WETH.toLowerCase();
      const loanUsd   = isWeth
        ? Number(BigInt(opp.quotedInput)) / 1e18 * (Number(_ethPrice) / 1e6)
        : Number(BigInt(opp.quotedInput)) / 1e6;
      const riskCheck = checkTradeAllowed(loanUsd, 0);
      if (!riskCheck.allowed) {
        logger.warn('EXEC', `Trade blocked by risk limits: ${riskCheck.reason}`);
      } else {
        try {
          const gasForecast = await getGasForecast(_provider);
          const plan = buildExecutionPlan(
            opp,
            opp.liveRouterAddress,
            opp.feeBuy,
            opp.feeSell,
            BigInt(opp.quotedOutput),
            gasForecast,
            _ethPrice,
          );
          const result = await executeLive(plan, _wallet, _provider, _fastExec ?? undefined);
          if (result.success) {
            logger.info('EXEC', `Live tx confirmed: ${result.txHash} via ${result.builder}`);
          } else {
            logger.warn('EXEC', `Live tx failed: ${result.error}`);
          }
        } catch (err: any) {
          logger.error('EXEC', `Live execution error: ${err.message}`);
        }
      }
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  return { logged: true, alerted: true, hash: opp.opportunityHash, netBps: opp.spreadBps };
}
