/**
 * Event contracts PUBLISHED by warehouse-service (D-56): the warehouse master data and the PIN
 * coverage that drive allocation. Producer-owned, docs/event-contracts.md.
 * Consumers: inventory-service (read-only projection: `inventory_warehouses` +
 * `inventory_warehouse_coverage`, same ids). Both are full snapshots, applied only when the
 * version is newer than the stored one (out-of-order and duplicate deliveries are harmless).
 */
import type { RoutingFallbackV1, RoutingRuleV1 } from '../../routing/index.js';
import type { EventEnvelope } from '../envelope.js';

export const WAREHOUSE_EVENT_SOURCE = 'warehouse-service';

export const WAREHOUSE_EVENTS = {
  upserted: 'warehouse.upserted.v1',
  coverageReplaced: 'warehouse.coverage_replaced.v1',
  stockChanged: 'warehouse.stock_changed.v1',
  thresholdsChanged: 'warehouse.thresholds_changed.v1',
  stockCutover: 'warehouse.stock_cutover.v1',
  jobFailed: 'warehouse.job_failed.v1',
  /** D-57b (F1): shipment lifecycle; order-service derives the order status from it. */
  shipmentStatusChanged: 'shipment.status_changed.v1',
  /** D-57b: gate-out; inventory issues the reservation line (once per dispatchId). */
  shipmentDispatched: 'shipment.dispatched.v1',
  /** D-57b: an order was split across warehouses / backordered (customer notice). */
  shipmentSplitPlanned: 'shipment.split_planned.v1',
  /** D-57b W3.12: full routing snapshot (rules, fallback, throttles); inventory applies it at checkout. */
  routingRulesReplaced: 'warehouse.routing_rules_replaced.v1',
  /** D-60: a goods receipt (CN) was posted; quality-service projects batches + auto-samples. */
  receiptCreated: 'warehouse.receipt_created.v1',
  /** D-60: batches that left in a shipment (gate-out); quality-service keeps the buyer list. */
  shipmentBatches: 'warehouse.shipment_batches.v1',
  /** D-60: warehouse expanded a quality decision into one task per warehouse holding the batch. */
  qualityTasksPlanned: 'warehouse.quality_tasks_planned.v1',
  /** D-60: one warehouse task of a quality decision finished (done / no stock / failed / superseded). */
  qualityTaskUpdated: 'warehouse.quality_task_updated.v1',
  /** D-62: an inbound gate entry changed status (W6 receiving, analytics, alerts consume later). */
  gateEntryStatusChanged: 'gate_entry.status_changed.v1',
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

/**
 * D-57a: inventory → warehouse stock cutover progress (freeze start / deadline, activation,
 * rollback). notification-service tells the people who edit stock and thresholds.
 */
export interface WarehouseStockCutoverV1 {
  phase: 'FROZEN' | 'ACTIVE' | 'ROLLED_BACK';
  mode: 'INVENTORY' | 'FROZEN' | 'WMS';
  frozenAt: string | null;
  freezeDeadline: string | null;
  activatedAt: string | null;
  rolledBackAt: string | null;
  reason: string | null;
}

/** D-57: a background job failed after all retries (dead-lettered) or its heartbeat is stale. */
export interface WarehouseJobFailedV1 {
  job: string;
  kind: 'DEAD_LETTER' | 'STALE';
  error: string | null;
  attempts: number;
  lastSuccessAt: string | null;
}

/** F1 shipment states (one shipment per order × warehouse). */
export type ShipmentStatusV1 =
  | 'PENDING_RELEASE'
  | 'RELEASED'
  | 'ALLOCATED'
  | 'ASSIGNED'
  | 'PICKING'
  | 'PACKING'
  | 'QC'
  | 'READY_TO_DISPATCH'
  | 'DISPATCHED'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'FULFILLED'
  | 'DELIVERY_FAILED'
  | 'RETURNED_TO_WAREHOUSE'
  | 'CANCELLED';

/**
 * A shipment moved. Carries a snapshot of every shipment of the order, so order-service derives
 * the order status (IN_FULFILMENT / PARTIALLY_DELIVERED / DELIVERED) without its own copy.
 * No PII and never an OTP.
 */
export interface ShipmentStatusChangedV1 {
  shipmentId: string;
  shipmentNo: string;
  orderId: string;
  orderNo: string;
  warehouseId: string;
  from: ShipmentStatusV1 | null;
  to: ShipmentStatusV1;
  at: string;
  /** Every shipment of the order after this change (cancelled ones included). */
  orderShipments: {
    shipmentId: string;
    warehouseId: string;
    status: ShipmentStatusV1;
    /**
     * Shipment row version (goes up on every change). Consumers keep the highest version per
     * shipment, because two shipments changing at once can each publish a snapshot without the
     * other's change. Additive: absent on events published before 2026-11-24.
     */
    version?: number;
    /** Delivered quantities per order line (delivered / fulfilled shipments). */
    deliveredLines: { lineNo: number; variantId: string; qty: number }[];
  }[];
}

/**
 * Gate-out of one shipment. inventory issues the reservation line (orderRef = orderId,
 * warehouseId, variantId) exactly once per `dispatchId`; no reservation id is needed (§2a.11).
 */
export interface ShipmentDispatchedV1 {
  dispatchId: string;
  shipmentId: string;
  orderId: string;
  warehouseId: string;
  lines: { variantId: string; qty: number }[];
}

/** An order was split across warehouses or partly backordered (customer notice). */
export interface ShipmentSplitPlannedV1 {
  orderId: string;
  orderNo: string;
  legs: { warehouseId: string; qty: number; plannedAt: string | null }[];
  backorders: { variantId: string; qty: number; promiseDate: string | null }[];
}

/** Full routing snapshot; a consumer keeps the highest version (see @farmx/infra/routing). */
export interface RoutingRulesReplacedV1 {
  version: number;
  rules: RoutingRuleV1[];
  fallback: RoutingFallbackV1;
  /** `capReached` = the daily order cap is used up (republished by the cap watch). */
  throttles: {
    warehouseId: string;
    paused: boolean;
    maxOrdersPerDay: number | null;
    capReached?: boolean;
  }[];
}

/** Variant facts carried on quality events (so the consumer needs no product lookup). */
export interface QualityVariantFactsV1 {
  variantId: string;
  productId: string;
  sku: string;
  productName: string;
  variantName: string;
  brandName: string | null;
  packLabel: string;
  imageUrl: string | null;
  temperatureClass: string;
}

/** D-60: a goods receipt (CN) and its batch lines. */
export interface WarehouseReceiptCreatedV1 {
  receiptId: string;
  cnNo: string;
  warehouseId: string;
  warehouseName: string;
  /** VENDOR · TRANSFER · RETURN · OPENING */
  sourceType: string;
  vendorId: string | null;
  vendorName: string | null;
  receivedAt: string;
  receivedBy: string | null;
  lines: {
    lineNo: number;
    variant: QualityVariantFactsV1;
    batchId: string;
    batchNo: string;
    mfgDate: string | null;
    expiryDate: string | null;
    serialized: boolean;
    qty: number;
    /** QC_HOLD when the SKU has a quality policy, QUARANTINED for a blocked batch. */
    initialStatus: string;
  }[];
}

/** D-60: what left in one shipment, per batch (gate-out). No PII: user id only. */
export interface WarehouseShipmentBatchesV1 {
  shipmentId: string;
  shipmentNo: string;
  orderId: string;
  orderNo: string;
  customerUserId: string;
  warehouseId: string;
  dispatchedAt: string;
  lines: { variantId: string; batchId: string; qty: number }[];
}

/** D-60: the warehouses that will apply a quality decision (empty = nobody holds the batch). */
export interface WarehouseQualityTasksPlannedV1 {
  decisionId: string;
  batchId: string;
  warehouseIds: string[];
}

export type QualityTaskStatusV1 = 'PENDING' | 'DONE' | 'FAILED' | 'NO_STOCK' | 'SUPERSEDED';

/** D-60: one warehouse task of a quality decision changed state. */
export interface WarehouseQualityTaskUpdatedV1 {
  decisionId: string;
  batchId: string;
  warehouseId: string;
  status: QualityTaskStatusV1;
  qtyMoved: number;
  attempts: number;
  error: string | null;
}

/**
 * D-62: gate entry status change (inbound truck at the warehouse gate). Ids and codes only — no
 * driver PII. `debitNoteRequired` / `noReceipt` flag W6 follow-ups (debit note W6.12, receipt
 * missing).
 */
export interface GateEntryStatusChangedV1 {
  gateEntryId: string;
  entryNo: string;
  shipmentId: string;
  shipmentNo: string;
  warehouseId: string;
  vendorId: string | null;
  restockRequestId: string | null;
  vehicleRegNo: string;
  /** ARRIVED · WEIGHED_IN · APPROVED · UNLOADING · UNLOADED · WEIGHED_OUT · PASS_OUT · BLOCKED · HELD · REJECTED · EXITED · CANCELLED */
  status: string;
  previousStatus: string | null;
  /** COMPLETED · REJECTED (set at REJECTED / EXITED). */
  outcome: string | null;
  netKg: string | null;
  varianceKg: string | null;
  debitNoteRequired: boolean;
  noReceipt: boolean;
  at: string;
}

export interface WarehouseEventMap {
  'gate_entry.status_changed.v1': GateEntryStatusChangedV1;
  'warehouse.receipt_created.v1': WarehouseReceiptCreatedV1;
  'warehouse.shipment_batches.v1': WarehouseShipmentBatchesV1;
  'warehouse.quality_tasks_planned.v1': WarehouseQualityTasksPlannedV1;
  'warehouse.quality_task_updated.v1': WarehouseQualityTaskUpdatedV1;
  'warehouse.routing_rules_replaced.v1': RoutingRulesReplacedV1;
  'shipment.status_changed.v1': ShipmentStatusChangedV1;
  'shipment.dispatched.v1': ShipmentDispatchedV1;
  'shipment.split_planned.v1': ShipmentSplitPlannedV1;
  'warehouse.job_failed.v1': WarehouseJobFailedV1;
  'warehouse.stock_cutover.v1': WarehouseStockCutoverV1;
  'warehouse.stock_changed.v1': WarehouseStockChangedV1;
  'warehouse.thresholds_changed.v1': WarehouseThresholdsChangedV1;
  'warehouse.upserted.v1': WarehouseUpsertedV1;
  'warehouse.coverage_replaced.v1': WarehouseCoverageReplacedV1;
}

export type WarehouseEvent<T extends WarehouseEventType = WarehouseEventType> = EventEnvelope<
  T,
  WarehouseEventMap[T]
>;
