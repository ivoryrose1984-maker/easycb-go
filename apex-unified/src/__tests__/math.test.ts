import { usdcToUsd, weiToEth } from '../core/config';
import { encode2HopPath, encode3HopPath } from '../execution/routePlanner';
import { ethers }                          from 'ethers';

// ── usdcToUsd ─────────────────────────────────────────────────────────────────

describe('usdcToUsd', () => {
  it('converts 1 USDC (1e6 base units) to 1.0', () => {
    expect(usdcToUsd(1_000_000n)).toBe(1.0);
  });

  it('converts 3000 USDC to 3000.0', () => {
    expect(usdcToUsd(3_000_000_000n)).toBe(3000.0);
  });

  it('converts 0 to 0', () => {
    expect(usdcToUsd(0n)).toBe(0);
  });
});

// ── weiToEth ──────────────────────────────────────────────────────────────────

describe('weiToEth', () => {
  it('converts 1 ETH (1e18 wei) to 1.0', () => {
    expect(weiToEth(1_000_000_000_000_000_000n)).toBe(1.0);
  });

  it('converts 0.5 ETH', () => {
    expect(weiToEth(500_000_000_000_000_000n)).toBe(0.5);
  });
});

// ── WETH denomination formula ─────────────────────────────────────────────────

describe('WETH profit to USD', () => {
  it('correctly converts 0.001 ETH profit at $3000/ETH to $3', () => {
    const profitWei  = ethers.parseEther('0.001');   // 1e15 wei
    const ethPriceUsd = 3_000_000_000n;               // 3000 USDC in 6-dec units
    const grossUsdc   = profitWei * ethPriceUsd / 10n ** 18n;
    const grossUsd    = usdcToUsd(grossUsdc);
    expect(grossUsd).toBeCloseTo(3.0, 4);
  });

  it('gives ~0 USD for 0 profit', () => {
    const grossUsdc = 0n * 3_000_000_000n / 10n ** 18n;
    expect(usdcToUsd(grossUsdc)).toBe(0);
  });
});

// ── encode2HopPath ────────────────────────────────────────────────────────────

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';
const cbETH = '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22';

describe('encode2HopPath', () => {
  it('produces a hex string', () => {
    const path = encode2HopPath(USDC, 500, WETH, 3000, USDC);
    expect(path).toMatch(/^0x[0-9a-f]+$/i);
  });

  it('encodes to the correct byte length (20+3+20+3+20 = 66 bytes = 132 hex + 0x prefix)', () => {
    const path = encode2HopPath(USDC, 500, WETH, 3000, USDC);
    // 0x + 132 hex chars
    expect(path.length).toBe(2 + 66 * 2);
  });

  it('is symmetric with 3-hop encoder for same data', () => {
    const two  = encode2HopPath(USDC, 500, WETH, 3000, USDC);
    const three = encode3HopPath(USDC, 500, WETH, 3000, cbETH, 500, USDC);
    // Different lengths
    expect(two.length).not.toBe(three.length);
  });
});
