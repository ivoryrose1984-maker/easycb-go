import { ethers } from 'ethers';

export function encode2HopPath(
  tokenIn:  string,
  feeBuy:   number,
  tokenMid: string,
  feeSell:  number,
  tokenOut: string
): string {
  const [a, b, c] = [tokenIn, tokenMid, tokenOut].map(t => ethers.getAddress(t));
  return ethers.solidityPacked(
    ['address', 'uint24', 'address', 'uint24', 'address'],
    [a, feeBuy, b, feeSell, c]
  );
}

export function encode3HopPath(
  t0: string, f0: number,
  t1: string, f1: number,
  t2: string, f2: number,
  t3: string
): string {
  const addrs = [t0, t1, t2, t3].map(t => ethers.getAddress(t));
  return ethers.solidityPacked(
    ['address', 'uint24', 'address', 'uint24', 'address', 'uint24', 'address'],
    [addrs[0], f0, addrs[1], f1, addrs[2], f2, addrs[3]]
  );
}
