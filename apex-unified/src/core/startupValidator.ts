import { ethers } from 'ethers';
import CONFIG from './config';
import { logger } from './logger';

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

const CL_ABI = [
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
];

const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
];

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

const CHAINLINK_FEEDS = [
  { key: 'chainlink:ETH/USD',   name: 'ETH/USD',   address: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70' },
  { key: 'chainlink:cbETH/USD', name: 'cbETH/USD', address: '0xd7818272B9e248357d13057AAb0B417aF31E817d' },
];

const EXPECTED_DECIMALS: Record<string, number> = {
  WETH: 18, USDC: 6, USDT: 6, DAI: 18, cbETH: 18, cbBTC: 8, AERO: 18,
};

const UNI_FEES  = [100, 500, 3000, 10000];
const CAKE_FEES = [100, 500, 2500, 3000, 10000];

const SCAN_PAIRS: [string, string][] = [
  [CONFIG.TOKENS.USDC,  CONFIG.TOKENS.WETH],
  [CONFIG.TOKENS.USDT,  CONFIG.TOKENS.WETH],
  [CONFIG.TOKENS.DAI,   CONFIG.TOKENS.WETH],
  [CONFIG.TOKENS.USDC,  CONFIG.TOKENS.USDT],
  [CONFIG.TOKENS.USDC,  CONFIG.TOKENS.DAI],
  [CONFIG.TOKENS.USDC,  CONFIG.TOKENS.cbETH],
  [CONFIG.TOKENS.WETH,  CONFIG.TOKENS.cbETH],
  [CONFIG.TOKENS.USDC,  CONFIG.TOKENS.cbBTC],
  [CONFIG.TOKENS.WETH,  CONFIG.TOKENS.cbBTC],
  [CONFIG.TOKENS.WETH,  CONFIG.TOKENS.AERO],
  [CONFIG.TOKENS.USDC,  CONFIG.TOKENS.AERO],
];

export interface ValidationResult {
  chainId:       number;
  ok:            boolean;
  disabledFeeds: Set<string>;
  poolExists:    Map<string, boolean>;
  validPools:    Set<string>;
  warnings:      string[];
  errors:        string[];
}

// Module-level cache — populated once at startup, read each block by scan signals.
let _result: ValidationResult | null = null;

export function poolKey(dex: string, fee: number, tokenA: string, tokenB: string): string {
  const [a, b] = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort();
  return `${dex}:${fee}:${a}:${b}`;
}

/**
 * Returns true if the pool for (dex, fee, tokenA, tokenB) is known to exist.
 * Permissive (true) if validation has not run or the pool was not checked.
 * False only when startup validation CONFIRMED no pool exists at this address.
 */
export function isPoolValid(dex: string, fee: number, tokenA: string, tokenB: string): boolean {
  if (_result === null) return true; // not validated yet — allow all
  const key   = poolKey(dex, fee, tokenA, tokenB);
  const known = _result.poolExists.get(key);
  return known !== false; // true if exists or check was skipped/failed
}

export function isFeedDisabled(feedKey: string): boolean {
  return _result?.disabledFeeds.has(feedKey) ?? false;
}

export async function runStartupValidation(provider: ethers.Provider): Promise<ValidationResult> {
  const result: ValidationResult = {
    chainId:       0,
    ok:            true,
    disabledFeeds: new Set(),
    poolExists:    new Map(),
    validPools:    new Set(),
    warnings:      [],
    errors:        [],
  };

  logger.info('VALIDATE', '═══════════════════ Startup validation ═══════════════════');

  // ── 1. Chain ID ─────────────────────────────────────────────────────────────
  try {
    const network  = await provider.getNetwork();
    result.chainId = Number(network.chainId);
    if (result.chainId !== 8453) {
      result.errors.push(`chainId=${result.chainId} (expected 8453 for Base)`);
      result.ok = false;
    } else {
      logger.info('VALIDATE', 'chainId=8453 (Base) ✓');
    }
  } catch (e: any) {
    result.errors.push(`chainId check failed: ${e.message}`);
    result.ok = false;
  }

  // ── 2. ERC20 token decimals ──────────────────────────────────────────────────
  const tokenEntries = Object.entries(CONFIG.TOKENS) as [string, string][];
  await Promise.allSettled(tokenEntries.map(async ([sym, addr]) => {
    const c   = new ethers.Contract(addr, ERC20_ABI, provider);
    try {
      const dec      = Number(await c.decimals());
      const expected = EXPECTED_DECIMALS[sym];
      if (expected !== undefined && dec !== expected) {
        result.errors.push(`${sym} decimals=${dec} (expected ${expected})`);
        result.ok = false;
      } else {
        logger.info('VALIDATE', `Token ${sym}: decimals=${dec} ✓`);
      }
    } catch (e: any) {
      result.warnings.push(`${sym} ERC20 check failed: ${e.message.slice(0, 60)}`);
    }
  }));

  // ── 3. Chainlink feed health ─────────────────────────────────────────────────
  await Promise.allSettled(CHAINLINK_FEEDS.map(async (feed) => {
    const c = new ethers.Contract(feed.address, CL_ABI, provider);
    try {
      const [dec, roundData] = await Promise.all([c.decimals(), c.latestRoundData()]);
      const answer    = roundData[1] as bigint;
      const updatedAt = roundData[3] as bigint;
      const ageSecs   = Math.floor(Date.now() / 1000) - Number(updatedAt);
      if (Number(dec) !== 8) {
        result.warnings.push(`Chainlink ${feed.name}: decimals=${dec} (expected 8)`);
      }
      if (answer <= 0n) {
        result.disabledFeeds.add(feed.key);
        result.warnings.push(`Chainlink ${feed.name}: answer=${answer} — disabled`);
      } else {
        logger.info('VALIDATE', `Chainlink ${feed.name}: answer=${answer} age=${Math.round(ageSecs / 3600)}h ✓`);
      }
    } catch (e: any) {
      result.disabledFeeds.add(feed.key);
      result.warnings.push(
        `Chainlink ${feed.name}: CALL_EXCEPTION — disabled (${e.code ?? e.message.slice(0, 50)})`
      );
    }
  }));

  // ── 4. Pool existence via factory.getPool() ──────────────────────────────────
  const uniFactory  = new ethers.Contract(CONFIG.CONTRACTS.UNI_FACTORY,  FACTORY_ABI, provider);
  const cakeFactory = new ethers.Contract(CONFIG.CONTRACTS.CAKE_FACTORY, FACTORY_ABI, provider);

  const poolChecks: (() => Promise<void>)[] = [];

  for (const [tA, tB] of SCAN_PAIRS) {
    for (const fee of UNI_FEES) {
      const key = poolKey('uni-v3', fee, tA, tB);
      poolChecks.push(async () => {
        try {
          const addr   = await uniFactory.getPool(tA, tB, fee) as string;
          const exists = addr.toLowerCase() !== ZERO_ADDR;
          result.poolExists.set(key, exists);
          if (exists) result.validPools.add(key);
        } catch (e: any) {
          // Leave absent — isPoolValid() is permissive for unchecked pools
          result.warnings.push(`Uni pool ${key}: ${e.message.slice(0, 50)}`);
        }
      });
    }
    for (const fee of CAKE_FEES) {
      const key = poolKey('cake-v3', fee, tA, tB);
      poolChecks.push(async () => {
        try {
          const addr   = await cakeFactory.getPool(tA, tB, fee) as string;
          const exists = addr.toLowerCase() !== ZERO_ADDR;
          result.poolExists.set(key, exists);
          if (exists) result.validPools.add(key);
        } catch (e: any) {
          result.warnings.push(`Cake pool ${key}: ${e.message.slice(0, 50)}`);
        }
      });
    }
  }

  // Batch 5 at a time with 200ms gaps to stay under free-tier CU limits (~130 CU/sec)
  const BATCH = 5;
  for (let i = 0; i < poolChecks.length; i += BATCH) {
    await Promise.allSettled(poolChecks.slice(i, i + BATCH).map(fn => fn()));
    if (i + BATCH < poolChecks.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  const checkedTotal  = result.poolExists.size;
  const existingTotal = result.validPools.size;
  const possibleTotal = SCAN_PAIRS.length * (UNI_FEES.length + CAKE_FEES.length);

  logger.info('VALIDATE',
    `Pools: ${existingTotal} exist / ${checkedTotal} confirmed / ${possibleTotal} possible` +
    (possibleTotal - checkedTotal > 0 ? ` (${possibleTotal - checkedTotal} checks failed — will try live)` : '')
  );

  if (result.disabledFeeds.size > 0) {
    logger.warn('VALIDATE', `Disabled feeds: ${[...result.disabledFeeds].join(', ')}`);
  }
  if (result.errors.length > 0) {
    logger.error('VALIDATE', `Errors: ${result.errors.join(' | ')}`);
  }
  if (result.warnings.length > 0) {
    logger.warn('VALIDATE',
      `Warnings (${result.warnings.length}): ` +
      result.warnings.slice(0, 3).join(' | ') +
      (result.warnings.length > 3 ? ' ...' : '')
    );
  }

  logger.info('VALIDATE', '═══════════════════════════════════════════════════════════');

  _result = result;
  return result;
}
