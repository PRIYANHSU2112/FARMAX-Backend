import type { RuleType, RuleWarning } from './storage-rules.rules.js';

export const RULE_TYPES: readonly RuleType[] = [
  'SEGREGATION',
  'HAZARD_CLASS',
  'FOOD_GRADE_ZONE',
  'INCOMPATIBLE',
];

export interface RuleInput {
  type: RuleType;
  name: string;
  subjectCategoryIds: string[];
  keepAwayCategoryIds?: string[];
  allowedZoneId?: string | null;
  /** Stored in metres; `minDistanceUnit: 'FEET'` converts. */
  minDistance?: number | null;
  minDistanceUnit?: 'METRES' | 'FEET';
  notes?: string | null;
  status?: 'ACTIVE' | 'INACTIVE';
}

export interface RuleUpdate extends Partial<Omit<RuleInput, 'type'>> {
  expectedVersion: number;
}

/** W2.08 table row (+ the "not enforced yet" flag the UI must show). */
export interface RuleView {
  id: string;
  type: RuleType;
  name: string;
  subjectCategories: { id: string; name: string | null }[];
  keepAwayCategories: { id: string; name: string | null }[];
  allowedZone: { id: string; code: string; name: string } | null;
  minDistanceM: string | null;
  notes: string | null;
  status: string;
  version: number;
  enforcement: 'NOT_ENFORCED';
  warnings: RuleWarning[];
}

export interface RulesSummary {
  activeRules: number;
  foodGradeZones: number;
  restrictedItems: number;
  itemsNeedingReview: number;
  enforcement: 'NOT_ENFORCED';
  modules: { putaway: false };
}
