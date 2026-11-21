/** Pure reward-points rules (D-54). Integers only (bigint): no floating point anywhere. */

/** Points earned on what the buyer finally paid: floor(net / paise-per-point). */
export const earnPoints = (netPaidPaise: bigint, paisePerPoint: number): bigint =>
  netPaidPaise <= 0n ? 0n : netPaidPaise / BigInt(paisePerPoint);

/**
 * Points a refund takes back from an order's lot: floor(earned × refund / base), never more than
 * what is still un-reversed. Rounds down (in the customer's favour).
 */
export const reversalPoints = (
  lot: { earnedPts: bigint; basePaise: bigint; reversedPts: bigint },
  refundPaise: bigint,
): bigint => {
  if (lot.basePaise <= 0n || refundPaise <= 0n) return 0n;
  const left = lot.earnedPts - lot.reversedPts;
  const share = (lot.earnedPts * refundPaise) / lot.basePaise;
  return share < left ? share : left;
};

/** FIFO by expiry: how many points to take from each lot (lots already sorted by expiry). */
export const allocate = (
  lots: readonly { id: string; remainingPts: bigint }[],
  need: bigint,
): { takes: { lotId: string; points: bigint }[]; shortfall: bigint } => {
  const takes: { lotId: string; points: bigint }[] = [];
  let left = need;
  for (const lot of lots) {
    if (left <= 0n) break;
    const take = lot.remainingPts < left ? lot.remainingPts : left;
    if (take > 0n) {
      takes.push({ lotId: lot.id, points: take });
      left -= take;
    }
  }
  return { takes, shortfall: left };
};

/** Why a conversion is refused (null = allowed). */
export const convertRefusal = (
  points: number,
  availablePts: bigint,
  rule: { min: number; step: number },
): 'BELOW_MINIMUM' | 'NOT_A_MULTIPLE' | 'INSUFFICIENT_POINTS' | null => {
  if (points < rule.min) return 'BELOW_MINIMUM';
  if (points % rule.step !== 0) return 'NOT_A_MULTIPLE';
  if (BigInt(points) > availablePts) return 'INSUFFICIENT_POINTS';
  return null;
};

/** Same day-of-month N months later (clamped to the month's last day). */
export const addMonths = (d: Date, months: number): Date => {
  const out = new Date(d.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
};

export const addDays = (d: Date, days: number): Date => new Date(d.getTime() + days * 86_400_000);
