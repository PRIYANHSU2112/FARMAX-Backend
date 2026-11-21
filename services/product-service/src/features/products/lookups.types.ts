export const LOOKUP_GROUPS = ['DOSAGE_FORM', 'ROUTE', 'SPECIES', 'UNIT', 'FLOCK_STAGE'] as const;
export type LookupGroup = (typeof LOOKUP_GROUPS)[number];

/** SPECIES meta: drives the withdrawal rules (R5/R6). */
export interface SpeciesMeta {
  producesMeat?: boolean;
  producesEggs?: boolean;
}

/** FLOCK_STAGE meta: legacy free-text values that map to this code (stages:map script). */
export interface FlockStageMeta {
  aliases?: string[];
}

export interface LookupRow {
  id: string;
  group: LookupGroup;
  code: string;
  label: string;
  description: string | null;
  meta: Record<string, unknown>;
  isActive: boolean;
  sortOrder: number;
  version: number;
}

export interface LookupRecord extends LookupRow {
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Storefront view. */
export type PublicLookup = Pick<LookupRow, 'id' | 'group' | 'code' | 'label' | 'meta'>;

export interface LookupListQuery {
  group?: LookupGroup;
  q?: string;
  isActive?: boolean;
}

export interface CreateLookupInput {
  group: LookupGroup;
  code: string;
  label: string;
  description?: string | null;
  meta?: Record<string, unknown>;
  isActive?: boolean;
  sortOrder?: number;
  reason: string;
}

export type UpdateLookupInput = Partial<
  Pick<CreateLookupInput, 'label' | 'description' | 'meta' | 'isActive' | 'sortOrder'>
> & { reason: string };
