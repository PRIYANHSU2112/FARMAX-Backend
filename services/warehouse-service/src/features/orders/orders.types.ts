import type { CursorQuery } from '@farmx/common/types';

import type { FulfilmentStatus, Lines } from './orders.rules.js';

export interface AllocationRow {
  orderId: string;
  warehouseId: string;
  status: FulfilmentStatus;
  lines: Lines;
  lineCount: number;
  unitCount: number;
  paidAt: Date;
  confirmedAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  lastEventAt: Date;
}

export interface HeaderRow {
  orderId: string;
  orderNo: string;
  shipToName: string | null;
  district: string | null;
  pinCode: string | null;
  placedAt: Date;
}

/** W2.03 Active Orders tab row. */
export interface WarehouseOrderView {
  orderId: string;
  /** null until order.placed is seen (events may arrive out of order). */
  orderNo: string | null;
  shipToName: string | null;
  district: string | null;
  pinCode: string | null;
  lineCount: number;
  unitCount: number;
  status: FulfilmentStatus;
  placedAt: string | null;
  paidAt: string;
  confirmedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
}

export type OrderStatusFilter = FulfilmentStatus | 'OPEN';

export interface OrderListQuery extends CursorQuery {
  status: OrderStatusFilter;
}

/** Open orders of one warehouse by status. */
export interface OpenOrderCounts {
  new: number;
  allocated: number;
}
