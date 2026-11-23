export const AREA_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type AreaPriority = (typeof AREA_PRIORITIES)[number];
export type AreaKind = 'DISTRICT' | 'IMPORTED';

/** Allocation rank of a DISTRICT area's PINs (lower = tried first). */
export const PRIORITY_RANK: Record<AreaPriority, number> = { HIGH: 10, MEDIUM: 50, LOW: 90 };

export interface AreaRecord {
  id: string;
  warehouseId: string;
  kind: AreaKind;
  stateCode: string | null;
  district: string | null;
  priority: AreaPriority | null;
  pinCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** W2.04 table row ("56 (e.g. 411001 – 411056)"). */
export interface AreaView {
  id: string;
  kind: AreaKind;
  stateCode: string | null;
  stateName: string | null;
  district: string | null;
  priority: AreaPriority | null;
  pinCount: number;
  firstPin: string | null;
  lastPin: string | null;
  updatedAt: string;
}

export interface AreaDetail extends AreaView {
  pins: string[];
  /** The PINs as compact ranges, for the edit form. */
  ranges: string[];
}

export interface ServiceAreasView {
  warehouseId: string;
  /** Send back as expectedVersion on every service-area write. */
  coverageVersion: number;
  summary: {
    districts: number;
    pinCodes: number;
    /** PINs still in the IMPORTED area: drives the "Move to district" banner. */
    unassignedPins: number;
    /** The priority that covers the most PINs (null when no district is assigned). */
    defaultPriority: AreaPriority | null;
  };
  areas: AreaView[];
}

export interface CreateAreaInput {
  expectedVersion: number;
  stateCode: string;
  district: string;
  priority: AreaPriority;
  /** Single PINs and/or ranges. */
  pins: string[];
}

export interface UpdateAreaInput {
  expectedVersion: number;
  stateCode?: string;
  district?: string;
  priority?: AreaPriority;
  addPins?: string[];
  removePins?: string[];
}

export interface ReassignInput {
  expectedVersion: number;
  /** PINs / ranges to move; omitted with `all: true` = every PIN of the imported area. */
  pins?: string[];
  all?: boolean;
  stateCode: string;
  district: string;
  priority: AreaPriority;
}

/** GET /coverage/:pinCode — who serves a PIN, in allocation order. */
export interface CoverageCandidate {
  warehouseId: string;
  code: string;
  name: string;
  type: string;
  status: string;
  priorityRank: number;
  warehousePriority: number;
  /** Would receive allocations now (ACTIVE and allocatable). */
  routable: boolean;
}
