/**
 * Triple-check path encoding — the most critical correctness requirement.
 * A wrong path causes the contract to swap into the wrong token and revert.
 */

jest.mock('dotenv/config', () => ({}));
jest.mock('dotenv', () => ({ config: jest.fn() }));

import { encodeTriangularPath, encode2HopPath } from '../core/triangularFinder';
import { ethers } from 'ethers';

// Canonical test addresses (not real, just deterministic)
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';
// Pass lowercase — encodeTriangularPath normalises via getAddress(addr.toLowerCase())
const USDT = '0xfde4c96c8593536e31f0e8c0fff4e4b5770b80ec';

describe('encode2HopPath', () => {
  it('encodes tokenIn|feeBuy|tokenMid|feeSell|tokenOut', () => {
    const path = encode2HopPath(USDC, 3000, WETH, 500, USDC);
    // Expected layout:
    //   bytes 0-19:  USDC (20 bytes)
    //   bytes 20-22: fee=3000 (3 bytes, big-endian) = 0x000BB8
    //   bytes 23-42: WETH (20 bytes)
    //   bytes 43-45: fee=500 (3 bytes) = 0x0001F4
    //   bytes 46-65: USDC (20 bytes)
    // Total: 66 bytes = 132 hex chars + '0x'
    expect(path.length).toBe(2 + 132); // '0x' + 132 hex chars

    // Verify first token (bytes 0-19)
    const firstAddr = '0x' + path.slice(2, 42);
    expect(firstAddr.toLowerCase()).toBe(USDC.toLowerCase());

    // Verify fee (bytes 20-22, 3 bytes = 6 hex chars)
    const fee1Hex = path.slice(42, 48);
    expect(parseInt(fee1Hex, 16)).toBe(3000);

    // Verify mid token (bytes 23-42, 20 bytes = 40 hex chars)
    const midAddr = '0x' + path.slice(48, 88);
    expect(midAddr.toLowerCase()).toBe(WETH.toLowerCase());

    // Verify sell fee
    const fee2Hex = path.slice(88, 94);
    expect(parseInt(fee2Hex, 16)).toBe(500);

    // Verify last token — must be USDC for round-trip
    const lastAddr = '0x' + path.slice(94, 134);
    expect(lastAddr.toLowerCase()).toBe(USDC.toLowerCase());
  });

  it('total length is always 66 bytes (2-hop)', () => {
    const path = encode2HopPath(USDC, 100, WETH, 3000, USDC);
    // 20 + 3 + 20 + 3 + 20 = 66 bytes = 132 hex nibbles
    expect(path.slice(2).length).toBe(132);
  });
});

describe('encodeTriangularPath', () => {
  it('encodes a 3-hop CLOSING path: A→B→C→A', () => {
    const path = encodeTriangularPath([USDC, WETH, USDT], [3000, 3000, 3000]);
    // Layout: USDC|3000|WETH|3000|USDT|3000|USDC
    // 20+3+20+3+20+3+20 = 89 bytes = 178 hex chars
    expect(path.slice(2).length).toBe(178);

    // CRITICAL: the path must CLOSE BACK to USDC
    const lastAddr = '0x' + path.slice(2 + 138, 2 + 178); // last 40 hex chars (20 bytes)
    expect(lastAddr.toLowerCase()).toBe(USDC.toLowerCase());
  });

  it('closing token matches opening token', () => {
    const path = encodeTriangularPath([USDC, WETH, USDT], [500, 3000, 100]);
    const firstAddr = '0x' + path.slice(2, 42);
    const lastAddr  = '0x' + path.slice(2 + 138, 2 + 178);
    expect(firstAddr.toLowerCase()).toBe(lastAddr.toLowerCase());
  });

  it('all 3 fee tiers are correctly packed', () => {
    const fees: [number, number, number] = [100, 500, 3000];
    const path = encodeTriangularPath([USDC, WETH, USDT], fees);
    // fee1: bytes 20-22 (hex chars 40-46)
    expect(parseInt(path.slice(42, 48), 16)).toBe(100);
    // fee2: bytes 43-45 (hex chars 86-92) = after USDC(20)+fee1(3)+WETH(20)
    expect(parseInt(path.slice(88, 94), 16)).toBe(500);
    // fee3: bytes 66-68 (hex chars 132-138) = after +USDT(20)
    expect(parseInt(path.slice(134, 140), 16)).toBe(3000);
  });

  it('3-hop path is 89 bytes; 2-hop path is 66 bytes (different functions)', () => {
    const tri = encodeTriangularPath([USDC, WETH, USDT], [3000, 3000, 3000]);
    const two = encode2HopPath(USDC, 3000, WETH, 3000, USDC);
    expect(tri.slice(2).length).toBe(178); // 89 bytes
    expect(two.slice(2).length).toBe(132); // 66 bytes
    expect(tri.slice(2).length).toBeGreaterThan(two.slice(2).length);
  });

  it('is ABI-encodable via solidityPacked (ethers compatibility)', () => {
    const path = encodeTriangularPath([USDC, WETH, USDT], [3000, 500, 100]);
    // Build the expected path using the same normalisation the function uses
    const norm = (a: string) => ethers.getAddress(a.toLowerCase());
    const manual = ethers.solidityPacked(
      ['address', 'uint24', 'address', 'uint24', 'address', 'uint24', 'address'],
      [norm(USDC), 3000, norm(WETH), 500, norm(USDT), 100, norm(USDC)]
    );
    expect(path).toBe(manual);
  });
});
