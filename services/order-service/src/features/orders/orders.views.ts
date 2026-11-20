import {
  type OrderWithLines,
  type RefundRequestRow,
  type StatusEventRow,
  UNPAID_STATUSES,
} from './orders.types.js';

const money = (m: { toFixed(d: number): string }) => m.toFixed(2);

export interface OrderSummaryView {
  id: string;
  orderNo: string;
  status: string;
  failureCode: string | null;
  paymentStatus: string;
  stockStatus: string;
  refundStatus: string;
  placedAt: Date;
  paymentDueAt: Date | null;
  itemCount: number;
  firstItemName: string | null;
  grandTotal: string;
  currency: string;
}

export interface OrderDetailView extends OrderSummaryView {
  paymentException: string | null;
  paidAt: Date | null;
  confirmedAt: Date | null;
  failedAt: Date | null;
  totals: Record<string, string>;
  billing: unknown;
  deliveryAddress: unknown;
  deliveryPromise: string | null;
  couponCode: string | null;
  lines: {
    lineNo: number;
    variantId: string;
    sku: string;
    name: string;
    hsnCode: string;
    gstRate: string;
    temperatureClass: string;
    qty: number;
    unitPrice: string;
    lineGross: string;
    lineDiscount: string;
    taxableValue: string;
    cgst: string;
    sgst: string;
    igst: string;
    lineTotal: string;
  }[];
  /** Every status change, oldest first (C-17b timeline). */
  timeline: {
    field: string;
    from: string | null;
    to: string;
    by: string;
    reasonCode: string | null;
    note: string | null;
    at: Date;
  }[];
  /** Refund decisions and their progress (requested ≠ completed). */
  refunds: {
    id: string;
    source: string;
    amount: string;
    status: string;
    expectedBy: Date | null;
    completedAt: Date | null;
    arn: string | null;
  }[];
  /** What the buyer may do now, with the reason when not. */
  actions: { pay: { allowed: boolean; reason: string | null } };
}

const payable = (o: OrderWithLines): { allowed: boolean; reason: string | null } => {
  if (o.status !== 'PENDING_ADMIN_CONFIRMATION')
    return { allowed: false, reason: `Order is ${o.status}` };
  if (!UNPAID_STATUSES.includes(o.paymentStatus))
    return { allowed: false, reason: `Payment is ${o.paymentStatus}` };
  if (o.paymentDueAt.getTime() <= Date.now())
    return { allowed: false, reason: 'The payment window has ended' };
  if (!['RESERVED', 'COMMITTED'].includes(o.stockStatus))
    return { allowed: false, reason: 'Stock is still being confirmed; try again in a moment' };
  return { allowed: true, reason: null };
};

export const toSummary = (o: OrderWithLines): OrderSummaryView => ({
  id: o.id,
  orderNo: o.orderNo,
  status: o.status,
  failureCode: o.failureCode,
  paymentStatus: o.paymentStatus,
  stockStatus: o.stockStatus,
  refundStatus: o.refundStatus,
  placedAt: o.placedAt,
  // The "Stock hold" countdown only matters while the buyer can still pay.
  paymentDueAt:
    o.status === 'PENDING_ADMIN_CONFIRMATION' && UNPAID_STATUSES.includes(o.paymentStatus)
      ? o.paymentDueAt
      : null,
  itemCount: o.lines.length,
  firstItemName: o.lines[0]?.name ?? null,
  grandTotal: money(o.grandTotal),
  currency: o.currency,
});

export const toDetail = (
  o: OrderWithLines,
  events: readonly StatusEventRow[],
  refunds: readonly RefundRequestRow[],
): OrderDetailView => ({
  ...toSummary(o),
  paymentException: o.paymentException,
  paidAt: o.paidAt,
  confirmedAt: o.confirmedAt,
  failedAt: o.failedAt,
  totals: {
    itemSubtotal: money(o.itemSubtotal),
    discountTotal: money(o.discountTotal),
    taxableAmount: money(o.taxableAmount),
    cgst: money(o.cgst),
    sgst: money(o.sgst),
    igst: money(o.igst),
    freight: money(o.freight),
    freightDiscount: money(o.freightDiscount),
    grandTotal: money(o.grandTotal),
    paidAmount: money(o.paidAmount),
    refundedAmount: money(o.refundedAmount),
  },
  billing: o.billing,
  deliveryAddress: o.deliveryAddress,
  deliveryPromise: o.deliveryPromise,
  couponCode: o.couponCode,
  lines: o.lines.map((l) => ({
    lineNo: l.lineNo,
    variantId: l.variantId,
    sku: l.sku,
    name: l.name,
    hsnCode: l.hsnCode,
    gstRate: money(l.gstRate),
    temperatureClass: l.temperatureClass,
    qty: l.qty,
    unitPrice: money(l.unitPrice),
    lineGross: money(l.lineGross),
    lineDiscount: money(l.lineDiscount),
    taxableValue: money(l.taxableValue),
    cgst: money(l.cgst),
    sgst: money(l.sgst),
    igst: money(l.igst),
    lineTotal: money(l.lineTotal),
  })),
  timeline: events.map((e) => ({
    field: e.field,
    from: e.fromValue,
    to: e.toValue,
    by: e.actorType,
    reasonCode: e.reasonCode,
    note: e.note,
    at: e.at,
  })),
  refunds: refunds.map((r) => ({
    id: r.id,
    source: r.source,
    amount: money(r.amount),
    status: r.status,
    expectedBy: r.expectedBy,
    completedAt: r.completedAt,
    arn: r.arn,
  })),
  actions: { pay: payable(o) },
});
