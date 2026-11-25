import type { CursorQuery } from '@farmx/common/types';

import type { StockFigures } from '../stats/index.js';

export const WAREHOUSE_TYPES = ['MOTHER', 'DEPOT'] as const;
export type WarehouseType = (typeof WAREHOUSE_TYPES)[number];

export const WAREHOUSE_STATUSES = ['SETUP', 'ACTIVE', 'LIMITED', 'INACTIVE'] as const;
export type WarehouseStatus = (typeof WAREHOUSE_STATUSES)[number];

export const TEMP_CLASSES = ['AMB', 'AMB_CTL', 'CC_REF', 'CC_FRZ', 'HAZ'] as const;
export type TempClass = (typeof TEMP_CLASSES)[number];

/** Fields an imported warehouse may still list in `reviewFields`. */
export const REVIEWABLE_FIELDS = [
  'district',
  'managerUserId',
  'capacityKg',
  'temperatureClasses',
] as const;

/** One row of `warehouse_warehouses` (decimals as strings). */
export interface WarehouseRecord {
  id: string;
  code: string;
  name: string;
  type: WarehouseType;
  status: WarehouseStatus;
  parentWarehouseId: string | null;
  managerUserId: string | null;
  phone: string | null;
  email: string | null;
  addressLine: string;
  landmark: string | null;
  city: string;
  district: string | null;
  stateCode: string;
  pinCode: string;
  latitude: string | null;
  longitude: string | null;
  tagline: string | null;
  totalAreaSqft: number | null;
  capacityKg: string | null;
  temperatureClasses: TempClass[];
  isAllocatable: boolean;
  priority: number;
  timezone: string;
  statusReason: string | null;
  statusChangedAt: Date | null;
  activatedAt: Date | null;
  importedAt: Date | null;
  reviewFields: string[];
  version: number;
  coverageVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ManagerView {
  userId: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
}

export interface SetupStep {
  key: 'details' | 'serviceArea' | 'storage' | 'calendar' | 'review';
  done: boolean;
  /** What is missing (human-readable). */
  issues: string[];
}

/** W2.03 header / W2.02 review / GET /:id. */
export interface WarehouseView extends Omit<WarehouseRecord, 'statusChangedAt' | 'activatedAt'> {
  stateName: string | null;
  manager: ManagerView | null;
  statusChangedAt: string | null;
  activatedAt: string | null;
  setup: { done: number; total: number; steps: SetupStep[] };
  /** Latest stock snapshot (null until the first refresh). */
  stock: StockFigures | null;
  /** usedKg ÷ capacityKg × 100; null without capacity or snapshot. */
  capacityUsedPct: number | null;
}

/** W2.01 table row. Stock and utilisation come from the latest stock snapshot (null before it). */
export interface WarehouseListItem {
  id: string;
  code: string;
  name: string;
  type: WarehouseType;
  status: WarehouseStatus;
  city: string;
  district: string | null;
  stateCode: string;
  stateName: string | null;
  manager: ManagerView | null;
  capacityKg: string | null;
  isAllocatable: boolean;
  reviewPending: boolean;
  setup: { done: number; total: number };
  stockUnits: number | null;
  usedKg: string | null;
  capacityUsedPct: number | null;
  /** < 100 → "based on X% of stock with known weight". */
  weightKnownPct: number | null;
  updatedAt: string;
}

export interface WarehouseListQuery extends CursorQuery {
  q?: string;
  type?: WarehouseType;
  status?: WarehouseStatus;
  stateCode?: string;
  city?: string;
}

/** Capacity as entered on the form; stored in kg. */
export interface CapacityInput {
  value: number;
  unit: 'KG' | 'TONNES';
}

export interface CreateWarehouseInput {
  code: string;
  name: string;
  type: WarehouseType;
  parentWarehouseId?: string | null;
  managerUserId?: string | null;
  phone?: string | null;
  email?: string | null;
  addressLine: string;
  landmark?: string | null;
  city: string;
  district: string;
  stateCode: string;
  pinCode: string;
  latitude?: number | null;
  longitude?: number | null;
  tagline?: string | null;
  totalAreaSqft?: number | null;
  capacity?: CapacityInput | null;
  temperatureClasses: TempClass[];
  isAllocatable?: boolean;
  priority?: number;
}

export interface UpdateWarehouseInput extends Partial<
  Omit<CreateWarehouseInput, 'code' | 'district'>
> {
  expectedVersion: number;
  district?: string | null;
  /** Imported values confirmed as correct without changing them (cleared from reviewFields). */
  confirm?: (typeof REVIEWABLE_FIELDS)[number][];
  reason?: string;
}

export type StatusAction = 'activate' | 'limit' | 'deactivate' | 'reactivate';

export interface StatusInput {
  expectedVersion: number;
  reason?: string;
}

export interface WarehouseSummary {
  total: number;
  byType: Record<WarehouseType, number>;
  byStatus: Record<WarehouseStatus, number>;
  /** Sum of the capacities that are set. */
  totalCapacityKg: string;
  /** On-hand units over the visible warehouses (latest snapshots). */
  totalStockUnits: number;
  usedCapacityKg: string;
  /** Used kg of warehouses WITH a capacity ÷ their total capacity; null when none has one. */
  capacityUsedPct: number | null;
  /** Unit-weighted share of stock with a known pack weight. */
  weightKnownPct: number | null;
  asOf: string | null;
}
