import type { Tx } from '@farmx/database';

/** Document number kinds: SMP-2026-0048 · COA-2026-0048 · QD-2026-0001. */
export type NumberKind = 'SMP' | 'COA' | 'QD';

/**
 * Next number of a kind for the current year, inside the caller's transaction (one atomic
 * upsert; concurrent callers serialise on the sequence row, a rollback gives the number back).
 */
export const nextNumber = async (tx: Tx, kind: NumberKind, now = new Date()): Promise<string> => {
  const year = now.getUTCFullYear();
  const rows = await tx.$queryRaw<{ last: number }[]>`
    INSERT INTO quality_sequences (kind, period, last) VALUES (${kind}, ${year}, 1)
    ON CONFLICT (kind, period) DO UPDATE SET last = quality_sequences.last + 1
    RETURNING last`;
  const last = rows[0]?.last ?? 1;
  return `${kind}-${year}-${String(last).padStart(4, '0')}`;
};
