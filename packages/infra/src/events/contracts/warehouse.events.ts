/**
 * Event contracts PUBLISHED by warehouse-service (D-56): the warehouse master data and the PIN
 * coverage that drive allocation. Producer-owned, docs/event-contracts.md.
 * Consumers: inventory-service (read-only projection: `inventory_warehouses` +
 * `inventory_warehouse_coverage`, same ids). Both are full snapshots, applied only when the
 * version is newer than the stored one (out-of-order and duplicate deliveries are harmless).
 */
import type { EventEnvelope } from '../envelope.js';

export const WAREHOUSE_EVENT_SOURCE = 'warehouse-service';

export const WAREHOUSE_EVENTS = {
  upserted: 'warehouse.upserted.v1',
  coverageReplaced: 'warehouse.coverage_replaced.v1',
  stockChanged: 'warehouse.stock_changed.v1',
  thresholdsChanged: 'warehouse.thresholds_changed.v1',
} as const;

export type WarehouseEventType = (typeof WAREHOUSE_EVENTS)[keyof typeof WAREHOUSE_EVENTS];

/** SETUP (draft) · ACTIVE · LIMITED (takes stock, no new allocations) · INACTIVE */
export type WarehouseStatusV1 = 'SETUP' | 'ACTIVE' | 'LIMITED' | 'INACTIVE';

/** Same values as product temperature classes: AMB · AMB_CTL · CC_REF · CC_FRZ · HAZ */
export type WarehouseTempClassV1 = 'AMB' | 'AMB_CTL' | 'CC_REF' | 'CC_FRZ' | 'HAZ';

/**
 * Full snapshot of one warehouse after any change (create, edit, status). `version` increases on
 * every change; a consumer keeps the highest one it has applied.
 */
export interface WarehouseUpsertedV1 {
  warehouseId: string;
  version: number;
  code: string;
  name: string;
  /** MOTHER (central) · DEPOT (C&F) */
  type: 'MOTHER' | 'DEPOT';
  status: WarehouseStatusV1;
  parentWarehouseId: string | null;
  addressLine: string;
  city: string;
  district: string | null;
  stateCode: string;
  pinCode: string;
  latitude: string | null;
  longitude: string | null;
  temperatureClasses: WarehouseTempClassV1[];
  /** The admin's switch; allocation also needs status ACTIVE. */
  isAllocatable: boolean;
  /** Lower = preferred when two warehouses cover a PIN at the same coverage priority. */
  priority: number;
  /** Soft-deleted draft: consumers drop it. */
  deleted: boolean;
}

/**
 * The COMPLETE PIN coverage of one warehouse (replaces the previous set). Lower priority = tried
 * first. `coverageVersion` increases on every coverage change (separate from `version`).
 */
export interface WarehouseCoverageReplacedV1 {
  warehouseId: string;
  coverageVersion: number;
  /** At most 5,000 entries. */
  entries: { pinCode: string; priority: number }[];
}

/**
 * D-57a: the WMS owns physical stock. One event per WMS movement batch that changes what
 * inventory counts: sellable stock (available + reserved + picked + packed) and damaged stock.
 * inventory-service applies the deltas to its warehouse × SKU totals idempotently (inbox, keyed
 * by `movementId`). Status-only moves inside the sellable pool (e.g. allocate, pick) send nothing.
 */
export interface WarehouseStockChangedV1 {
  /** Idempotency key: one per WMS command. */
  movementId: string;
  warehouseId: string;
  /** What happened, for the inventory ledger: RECEIPT · QC_RELEASE · QC_HOLD · DAMAGE · QUARANTINE · EXPIRE · WRITE_OFF · ADJUSTMENT · TRANSFER_OUT · TRANSFER_IN · RETURN · RESTOCK · OPENING */
  kind: string;
  /** Human reference (CN-…, ADJ-…, TR-…). */
  refNo: string | null;
  lines: { variantId: string; sellableDelta: number; damagedDelta: number }[];
  actorUserId: string | null;
}

/** D-57a: thresholds are owned by the WMS; inventory keeps a read-only copy (one-way). */
export interface WarehouseThresholdsChangedV1 {
  warehouseId: string;
  variantId: string;
  safetyStock: number;
  reorderLevel: number;
  targetStock: number;
  /** Monotonic per warehouse × SKU; older versions are ignored. */
  version: number;
}

export interface WarehouseEventMap {
  'warehouse.stock_changed.v1': WarehouseStockChangedV1;
  'warehouse.thresholds_changed.v1': WarehouseThresholdsChangedV1;
  'warehouse.upserted.v1': WarehouseUpsertedV1;
  'warehouse.coverage_replaced.v1': WarehouseCoverageReplacedV1;
}

export type WarehouseEvent<T extends WarehouseEventType = WarehouseEventType> = EventEnvelope<
  T,
  WarehouseEventMap[T]
>;
