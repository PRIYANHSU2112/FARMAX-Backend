/**
 * Event contracts PUBLISHED by inventory-service (producer-owned, docs/event-contracts.md).
 * Consumers: product-service + order-service (availability projections), order-service (reservation
 * lifecycle, docs/oms), notifications (low stock).
 */
import type { EventEnvelope } from '../envelope.js';

export const INVENTORY_EVENT_SOURCE = 'inventory-service';

export const INVENTORY_EVENTS = {
  availabilityChanged: 'inventory.availability_changed.v1',
  lowStock: 'inventory.low_stock.v1',
  batchExpiring: 'inventory.batch_expiring.v1',
  reservationExpired: 'inventory.reservation_expired.v1',
  reservationCommitted: 'inventory.reservation_committed.v1',
  reservationRejected: 'inventory.reservation_rejected.v1',
  reservationReleased: 'inventory.reservation_released.v1',
} as const;

export type InventoryEventType = (typeof INVENTORY_EVENTS)[keyof typeof INVENTORY_EVENTS];

/** Network-wide sellable quantity of one variant after a stock change. */
export interface AvailabilityChangedV1 {
  variantId: string;
  /** Sum over allocatable warehouses of max(0, onHand − reserved − safetyStock). */
  availableQty: number;
  inStock: boolean;
  lowStock: boolean;
  /**
   * Per allocatable node (warehouse) breakdown, sorted by nodeId. The FULL set for the variant: a
   * node missing here has no sellable stock. Optional for older producers (additive to v1).
   */
  byNode?: { nodeId: string; availableQty: number; inStock: boolean }[];
  /** Monotonic per variant — consumers ignore older values. */
  sequence: number;
}

/** Sent once when a warehouse × variant crosses down to its reorder level (not repeated while low). */
export interface LowStockV1 {
  variantId: string;
  warehouseId: string;
  availableQty: number;
  threshold: number;
}

export interface BatchExpiringV1 {
  variantId: string;
  batchId: string;
  batchNo: string;
  warehouseId: string;
  expiryDate: string;
  quantity: number;
}

/** An ACTIVE reservation passed its payment window; its stock is free again. */
export interface ReservationExpiredV1 {
  reservationId: string;
  orderRef: string;
}

/** The order's stock is held with no expiry (after `order.paid.v1`). Re-sent on a duplicate commit. */
export interface ReservationCommittedV1 {
  reservationId: string;
  orderRef: string;
  /** Committed after it had expired: the stock was secured again (recovery). */
  recovered: boolean;
}

/** A late payment could not be honoured: the reservation had expired and the stock is gone. */
export interface ReservationRejectedV1 {
  reservationId: string;
  orderRef: string;
  shortfall: { variantId: string; requested: number; available: number }[];
}

/** Stock released (fully, or for the listed lines on a partial cancel). Re-sent on a duplicate. */
export interface ReservationReleasedV1 {
  reservationId: string;
  orderRef: string;
  /** FULL: nothing is held any more; PARTIAL: only `lines` were released. */
  scope: 'FULL' | 'PARTIAL';
  lines: { variantId: string; qty: number }[];
}

export interface InventoryEventMap {
  'inventory.availability_changed.v1': AvailabilityChangedV1;
  'inventory.low_stock.v1': LowStockV1;
  'inventory.batch_expiring.v1': BatchExpiringV1;
  'inventory.reservation_expired.v1': ReservationExpiredV1;
  'inventory.reservation_committed.v1': ReservationCommittedV1;
  'inventory.reservation_rejected.v1': ReservationRejectedV1;
  'inventory.reservation_released.v1': ReservationReleasedV1;
}

export type InventoryEvent<T extends InventoryEventType = InventoryEventType> = EventEnvelope<
  T,
  InventoryEventMap[T]
>;
