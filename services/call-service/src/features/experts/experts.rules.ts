import type { AvailabilityInput, MatchReason } from './experts.types.js';

/** A rule problem, path relative to the request body. */
export interface Issue {
  path: string;
  message: string;
}

const day = (date: string | null | undefined, fallback: string): string => date ?? fallback;

/**
 * Checks a weekly schedule against the expert's channels:
 *  - validFrom ≤ validTo;
 *  - rule channels ⊆ the expert's channels;
 *  - two rules of the same weekday whose date windows intersect must not overlap in time
 *    (touching is fine: 09:00–13:00 + 13:00–18:00).
 */
export const checkAvailability = (input: AvailabilityInput, expertChannels: readonly string[]): Issue[] => {
  const issues: Issue[] = [];
  const offered = new Set(expertChannels);
  input.rules.forEach((rule, i) => {
    if (rule.validFrom != null && rule.validTo != null && rule.validFrom > rule.validTo)
      issues.push({ path: `rules.${i}.validTo`, message: 'validTo must not be before validFrom' });
    for (const channel of rule.channels ?? [])
      if (!offered.has(channel))
        issues.push({ path: `rules.${i}.channels`, message: `expert does not offer ${channel}` });
  });
  for (let a = 0; a < input.rules.length; a += 1) {
    for (let b = a + 1; b < input.rules.length; b += 1) {
      const x = input.rules[a];
      const y = input.rules[b];
      if (x === undefined || x.weekday !== y?.weekday) continue;
      const datesMeet =
        day(x.validFrom, '0000-01-01') <= day(y.validTo, '9999-12-31') &&
        day(y.validFrom, '0000-01-01') <= day(x.validTo, '9999-12-31');
      if (datesMeet && x.startMinute < y.endMinute && y.startMinute < x.endMinute)
        issues.push({ path: `rules.${b}`, message: `overlaps rules.${a} on the same weekday` });
    }
  }
  return issues;
};

// ── recommendation ──

export interface RecommendInput {
  brandId: string;
  /** Category ids root → product's category. */
  categoryPath: readonly string[];
  /** The farm's production types (empty when no farm is given). */
  productionTypes: readonly string[];
  language?: string | undefined;
}

export interface Candidate {
  id: string;
  brandIds: readonly string[];
  categoryIds: readonly string[];
  productionTypes: readonly string[];
  languages: readonly string[];
  ratingAvg: number | null;
  onTimePct: number | null;
  priority: number;
}

export const WEIGHTS = {
  brand: 40,
  /** Expert tagged with the product's own category. */
  categoryExact: 25,
  /** Expert tagged with an ancestor category. */
  categoryAncestor: 15,
  productionType: 15,
  language: 10,
  online: 20,
  /** × ratingAvg / 5 */
  rating: 10,
  /** × onTimePct / 100 */
  onTime: 5,
  /** priority is capped at this */
  priorityMax: 10,
} as const;

export interface Scored {
  id: string;
  score: number;
  matchedOn: MatchReason[];
}

/** Score of one candidate (higher = better). Pure; `online` comes from presence. */
export const scoreCandidate = (c: Candidate, input: RecommendInput, online: boolean): Scored => {
  const matchedOn: MatchReason[] = [];
  let score = 0;
  if (c.brandIds.includes(input.brandId)) {
    score += WEIGHTS.brand;
    matchedOn.push('BRAND');
  }
  const own = input.categoryPath.at(-1);
  if (own !== undefined && c.categoryIds.includes(own)) {
    score += WEIGHTS.categoryExact;
    matchedOn.push('CATEGORY');
  } else if (input.categoryPath.some((id) => c.categoryIds.includes(id))) {
    score += WEIGHTS.categoryAncestor;
    matchedOn.push('CATEGORY');
  }
  if (input.productionTypes.some((t) => c.productionTypes.includes(t))) {
    score += WEIGHTS.productionType;
    matchedOn.push('PRODUCTION_TYPE');
  }
  if (input.language !== undefined && c.languages.includes(input.language)) {
    score += WEIGHTS.language;
    matchedOn.push('LANGUAGE');
  }
  if (online) score += WEIGHTS.online;
  if (c.ratingAvg !== null) score += (WEIGHTS.rating * Math.min(Math.max(c.ratingAvg, 0), 5)) / 5;
  if (c.onTimePct !== null) score += (WEIGHTS.onTime * Math.min(Math.max(c.onTimePct, 0), 100)) / 100;
  score += Math.min(Math.max(c.priority, 0), WEIGHTS.priorityMax);
  return { id: c.id, score: Math.round(score * 100) / 100, matchedOn };
};

/**
 * Best `limit` candidates that match the product at all (brand, category or production type),
 * highest score first; ties → id (stable).
 */
export const rankCandidates = (
  candidates: readonly Candidate[],
  input: RecommendInput,
  online: ReadonlySet<string>,
  limit: number,
): Scored[] =>
  candidates
    .map((c) => scoreCandidate(c, input, online.has(c.id)))
    .filter((s) => s.matchedOn.some((m) => m !== 'LANGUAGE'))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, limit);
