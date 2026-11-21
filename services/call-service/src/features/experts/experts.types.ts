import type { Channel } from '../options/index.js';

export const EXPERT_TYPES = ['VET', 'SALES_REP', 'SPECIALIST'] as const;
export type ExpertType = (typeof EXPERT_TYPES)[number];

/** farm-service `ProductionType` values (kept as strings here: no cross-service enum coupling). */
export const PRODUCTION_TYPES = [
  'LAYER',
  'BROILER',
  'BROILER_BREEDER',
  'LAYER_BREEDER',
  'HATCHERY',
  'FEED_MILL',
  'BACKYARD',
] as const;

/** Admin view of a profile. */
export interface ExpertView {
  id: string;
  userId: string;
  type: ExpertType;
  displayName: string;
  title: string | null;
  qualification: string | null;
  photoUrl: string | null;
  experienceYears: number | null;
  languages: string[];
  brandIds: string[];
  categoryIds: string[];
  productionTypes: string[];
  territoryCodes: string[];
  channels: Channel[];
  ratingAvg: number | null;
  onTimePct: number | null;
  maxPerDay: number;
  priority: number;
  isBookable: boolean;
  isActive: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** What a farmer may see about an expert (no user id, skills or internal flags). */
export interface ExpertCard {
  id: string;
  type: ExpertType;
  displayName: string;
  title: string | null;
  qualification: string | null;
  photoUrl: string | null;
  experienceYears: number | null;
  languages: string[];
  ratingAvg: number | null;
  onTimePct: number | null;
}

export interface CreateExpertInput {
  userId: string;
  type: ExpertType;
  displayName: string;
  title?: string | null;
  qualification?: string | null;
  photoUrl?: string | null;
  experienceYears?: number | null;
  languages: string[];
  brandIds?: string[];
  categoryIds?: string[];
  productionTypes?: string[];
  territoryCodes?: string[];
  channels: Channel[];
  maxPerDay?: number;
  priority?: number;
  isBookable?: boolean;
}

/** Columns a profile update may change (the service has checked them). */
export type ExpertPatch = Partial<Omit<CreateExpertInput, 'userId'>> & { isActive?: boolean };

export type UpdateExpertInput = Partial<Omit<CreateExpertInput, 'userId'>> & {
  isActive?: boolean;
  reason?: string;
};

/** Fields an expert may edit on their own profile (skills stay with admins). */
export interface UpdateMyProfileInput {
  title?: string | null;
  photoUrl?: string | null;
  languages?: string[];
}

export interface ExpertListQuery {
  cursor?: string;
  limit: number;
  type?: ExpertType;
  isActive?: boolean;
  isBookable?: boolean;
  brandId?: string;
  categoryId?: string;
  q?: string;
}

// ── availability ──

/** Weekly interval, IST minutes from midnight; `validFrom/To` = IST dates `YYYY-MM-DD`. */
export interface RuleInput {
  weekday: number;
  startMinute: number;
  endMinute: number;
  /** Empty = every channel the expert offers. */
  channels?: Channel[];
  validFrom?: string | null;
  validTo?: string | null;
}

/** Daily gap; `weekday` null = every day. */
export interface BreakInput {
  weekday?: number | null;
  startMinute: number;
  endMinute: number;
}

export interface AvailabilityInput {
  rules: RuleInput[];
  breaks: BreakInput[];
}

export interface AvailabilityView {
  rules: (Required<Omit<RuleInput, 'validFrom' | 'validTo'>> & {
    id: string;
    validFrom: string | null;
    validTo: string | null;
  })[];
  breaks: { id: string; weekday: number | null; startMinute: number; endMinute: number }[];
}

export interface TimeOffInput {
  startAt: string;
  endAt: string;
  reason?: string | null;
}

export interface TimeOffView {
  id: string;
  startAt: Date;
  endAt: Date;
  reason: string | null;
  createdByUserId: string;
  createdAt: Date;
}

export interface HolidayInput {
  date: string;
  territoryCode?: string | null;
  name: string;
}

export interface HolidayView {
  id: string;
  date: string;
  territoryCode: string | null;
  name: string;
}

// ── recommendation ──

export type MatchReason = 'BRAND' | 'CATEGORY' | 'PRODUCTION_TYPE' | 'LANGUAGE';

export interface RecommendQuery {
  productId: string;
  farmId?: string;
  language?: string;
  limit: number;
}

export interface RecommendedExpert extends ExpertCard {
  online: boolean;
  /** The app may pass this expert as `preferredExpertId` on a hold (honoured only if free). */
  isBookable: boolean;
  matchedOn: MatchReason[];
}

export interface RecommendedView {
  /** The card is advice, never an assignment: the call is taken by the rep assigned at hold. */
  assignment: 'RECOMMENDATION_ONLY';
  experts: RecommendedExpert[];
}
