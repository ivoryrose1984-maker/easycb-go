// Solidly stable-pool AMM math — ported from Aerodrome on-chain reference.
//
// Stable invariant: x³y + xy³ = k  (in normalized 1e18 space)
// Volatile pools use x·y=k — see optimalInputCFMM in flashLoanPlanner.ts.
//
// All internal arithmetic operates in 1e18-normalized units.
// Inputs must be converted via their token decimals before calling.

const SCALE = 10n ** 18n;

// ── f(x0, y) = x0·y³ + x0³·y  (scaled to avoid overflow) ────────────────────
// Mirrors Aerodrome's `_f` function exactly.
export function solidlyF(x0: bigint, y: bigint): bigint {
  const y2  = y  * y  / SCALE;
  const x02 = x0 * x0 / SCALE;
  return x0 * (y2 * y / SCALE) / SCALE + (x02 * x0 / SCALE) * y / SCALE;
}

// ── d(x0, y) = 3x0·y² + x0³  (derivative of f w.r.t. y) ─────────────────────
// Mirrors Aerodrome's `_d` function exactly.
export function solidlyD(x0: bigint, y: bigint): bigint {
  const y2  = y  * y  / SCALE;
  const x02 = x0 * x0 / SCALE;
  return 3n * x0 * y2 / SCALE + x02 * x0 / SCALE;
}

// ── Newton-Raphson solve for y given x1 and target invariant xy ───────────────
// Mirrors Aerodrome's `_get_y`: converges when |Δy| ≤ 1, max 255 iterations.
// Initial guess y0 = current y (pre-swap reserve, normalized).
export function solidlyGetY(x0: bigint, xy: bigint, y: bigint): bigint {
  for (let i = 0; i < 255; i++) {
    const yPrev = y;
    const k     = solidlyF(x0, y);
    const d     = solidlyD(x0, y);
    if (d === 0n) break;
    if (k < xy) {
      y = y + (xy - k) * SCALE / d;
    } else {
      y = y - (k - xy) * SCALE / d;
    }
    const diff = y > yPrev ? y - yPrev : yPrev - y;
    if (diff <= 1n) return y;
  }
  return y;
}

// ── getAmountOutStable ─────────────────────────────────────────────────────────
// Off-chain quote for a single Aerodrome stable-pool hop.
// Matches on-chain Aerodrome Router `getAmountOut` for stable=true pools.
//
// @param amountIn   Raw token units (not normalized)
// @param reserveIn  Pool reserve of tokenIn (raw units)
// @param reserveOut Pool reserve of tokenOut (raw units)
// @param decIn      Decimals of tokenIn  (e.g. 6 for USDC, 18 for DAI/WETH)
// @param decOut     Decimals of tokenOut
// @param feeBps     Pool fee in bps (default 5 = 0.05% for Aerodrome stable)
// @returns amountOut in raw tokenOut units, 0 on any failure/overflow
export function getAmountOutStable(
  amountIn:   bigint,
  reserveIn:  bigint,
  reserveOut: bigint,
  decIn:      number,
  decOut:     number,
  feeBps = 5n,
): bigint {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) return 0n;

  const scaleIn  = 10n ** BigInt(decIn);
  const scaleOut = 10n ** BigInt(decOut);

  const amountInFee = amountIn * (10_000n - feeBps) / 10_000n;

  const x0Norm = reserveIn  * SCALE / scaleIn;
  const y0Norm = reserveOut * SCALE / scaleOut;
  const dxNorm = amountInFee * SCALE / scaleIn;

  const xy     = solidlyF(x0Norm, y0Norm);
  const x1Norm = x0Norm + dxNorm;
  const y1Norm = solidlyGetY(x1Norm, xy, y0Norm);

  if (y1Norm >= y0Norm) return 0n;
  const amountOut = (y0Norm - y1Norm) * scaleOut / SCALE;
  return amountOut > reserveOut ? 0n : amountOut;
}
