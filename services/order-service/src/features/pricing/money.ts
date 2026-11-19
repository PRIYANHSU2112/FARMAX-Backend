/**
 * Integer money. The engine works in PAISE (1 ₹ = 100 paise) and percentages in BASIS POINTS
 * (1 % = 100 bp), so every step is exact integer math. Decimal strings ("1420.00", "2.5") are
 * converted only at the repository / API boundary.
 */
export type Paise = number;
/** Basis points: 250 = 2.5 %. */
export type BasisPoints = number;

/** "1420", "1420.5", "1420.50", 1420.5 or a Prisma Decimal → paise (exact, no float math). */
export function toPaise(value: string | number | { toString(): string }): Paise {
  return scaled(String(value), 2);
}

/** "2.5" / "18.00" / 18 → basis points (250 / 1800 / 1800). */
export function toBasisPoints(percent: string | number | { toString(): string }): BasisPoints {
  return scaled(String(percent), 2);
}

/** 142000 → "1420.00" (API / Decimal column). */
export function fromPaise(paise: Paise): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${String(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
}

/** 250 → "2.50". */
export const fromBasisPoints = fromPaise;

/** Round-half-up of amount × bp / 10 000 (e.g. 15 % of ₹5,000 = 75 000 paise). */
export function percentOf(amount: Paise, bp: BasisPoints): Paise {
  return divRoundHalfUp(amount * bp, 10_000);
}

/** Integer division, half rounded away from zero (amounts here are never negative). */
export function divRoundHalfUp(numerator: number, denominator: number): number {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

/**
 * Splits `total` across `weights` in proportion, exactly: each share is floor(total × w / Σw);
 * the leftover paise go one each to the largest weights (ties → lower index). Σ shares = total.
 * Zero total weight → all zeros (nothing to allocate onto).
 */
export function allocate(total: Paise, weights: readonly number[]): Paise[] {
  const sum = weights.reduce((a, w) => a + w, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const shares = weights.map((w) => Math.floor((total * w) / sum));
  let left = total - shares.reduce((a, s) => a + s, 0);
  const order = weights
    .map((w, i) => ({ w, i }))
    .filter((x) => x.w > 0)
    .sort((a, b) => b.w - a.w || a.i - b.i);
  for (let k = 0; left > 0 && order.length > 0; k = (k + 1) % order.length) {
    const target = order[k];
    if (target === undefined) break;
    shares[target.i] = (shares[target.i] ?? 0) + 1;
    left -= 1;
  }
  return shares;
}

export const sum = (values: readonly number[]): number => values.reduce((a, v) => a + v, 0);

function scaled(raw: string, decimals: number): number {
  const text = raw.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) throw new Error(`Not a decimal amount: "${raw}"`);
  const [, sign, whole, fraction = ''] = match;
  const frac = fraction.padEnd(decimals + 1, '0');
  let value = Number(whole) * 10 ** decimals + Number(frac.slice(0, decimals));
  // Half-up on the first dropped digit (columns are 2 dp, so this only guards odd inputs).
  if (Number(frac[decimals]) >= 5) value += 1;
  return sign === '-' ? -value : value;
}
