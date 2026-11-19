import type { DuplicateCandidate } from './farms.types.js';

export type DuplicateSignal =
  'PAN_OTHER_OWNER' | 'GSTIN_OTHER_OWNER' | 'GEO_SAME_OWNER' | 'GEO_NAME';

export interface DuplicateMatch {
  candidate: DuplicateCandidate;
  signals: DuplicateSignal[];
  score: number;
}

const WEIGHTS: Readonly<Record<DuplicateSignal, number>> = {
  PAN_OTHER_OWNER: 60,
  GSTIN_OTHER_OWNER: 60,
  GEO_SAME_OWNER: 40,
  GEO_NAME: 40,
};

export const NAME_SIMILARITY_THRESHOLD = 0.6;

/** Pure scoring of the dedupe query's rows (plan §2 rule 5). Returns the strongest match or null. */
export function scoreCandidates(
  candidates: readonly DuplicateCandidate[],
  radiusM: number,
): DuplicateMatch | null {
  let best: DuplicateMatch | null = null;
  for (const c of candidates) {
    const near = c.distanceM !== null && c.distanceM <= radiusM;
    const signals: DuplicateSignal[] = [];
    if (c.panMatch && !c.sameOwner) signals.push('PAN_OTHER_OWNER');
    if (c.gstinMatch && !c.sameOwner) signals.push('GSTIN_OTHER_OWNER');
    if (near && c.sameOwner) signals.push('GEO_SAME_OWNER');
    if (near && !c.sameOwner && c.nameSimilarity >= NAME_SIMILARITY_THRESHOLD)
      signals.push('GEO_NAME');
    if (signals.length === 0) continue;
    const score = Math.min(
      100,
      signals.reduce((sum, s) => sum + WEIGHTS[s], 0),
    );
    if (best === null || score > best.score) best = { candidate: c, signals, score };
  }
  return best;
}
