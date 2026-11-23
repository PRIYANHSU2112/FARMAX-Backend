import { createHash } from 'node:crypto';

import type {
  ContentCorrectedV1,
  ContentEventBaseV1,
  ContentPublishedV1,
  ContentRetractedV1,
  EventEnvelope,
  LowStockV1,
  OrderConfirmedV1,
  OrderPlacedV1,
  OrderReviewOverdueV1,
  OrderStockReleaseV1,
  PaymentCapturedV1,
  PaymentFailedV1,
  RefundFailedV1,
  RefundInitiatedV1,
  RefundProcessedV1,
} from '@farmx/infra/events';

import type { OrderRef } from '../audience/index.js';
import type { NotificationPriority } from '../../domain.js';
import type { ContentAudienceScope } from '../../adapters/farm-directory.js';
import type { NotificationDraft } from '../notifications/index.js';
import { SUPPORT_RULES } from './events.support.js';

/**
 * Event → notification rules (pure). Only events that are PUBLISHED today are bound
 * (docs/event-contracts.md). Buyer notifications go to the order owner from the order projection
 * (`order.placed.v1` is the only order event carrying the buyer); staff ones to permission holders.
 * Dedupe keys are business keys, so recovery re-sends with a new event id never notify twice.
 */
export interface Rule {
  /** Needs the order owner / number from the projection (missing → retry, then DLQ). */
  needsOrder: boolean;
  build: (event: EventEnvelope, order: OrderRef | null) => NotificationDraft[];
}

const paise = (amount: number) => amount / 100;

const base = (event: EventEnvelope) => ({ source: 'event', sourceEventId: event.id }) as const;

/** Buyer notification for one order (customer app, deep link to the order). */
const buyer = (
  event: EventEnvelope,
  order: OrderRef,
  d: Pick<NotificationDraft, 'dedupeKey' | 'category' | 'templateKey' | 'channels' | 'vars'> &
    Partial<Pick<NotificationDraft, 'priority'>>,
): NotificationDraft => ({
  ...base(event),
  priority: 'NORMAL',
  ...d,
  app: 'CUSTOMER',
  audience: { kind: 'users', userIds: [order.userId] },
  entityType: 'order',
  entityId: order.orderId,
  data: { entityType: 'order', entityId: order.orderId, orderNo: order.orderNo },
});

const must = (order: OrderRef | null, event: EventEnvelope): OrderRef => {
  if (order === null) throw new Error(`order projection missing for ${event.type} ${event.id}`);
  return order;
};

/** Customer-facing text for order failure codes (order-service FailureCode). */
const FAILURE_TEXT: Readonly<Record<string, string>> = {
  PAYMENT_NOT_COMPLETED: 'payment was not completed in time',
  STOCK_UNAVAILABLE: 'the items went out of stock',
  STOCK_UNAVAILABLE_AFTER_PAYMENT: 'the items went out of stock',
  PLACEMENT_ERROR: 'we could not complete it',
};

/** Stable id of a partial cancellation (same lines → same key, whatever the event id). */
const linesKey = (lines: readonly { variantId: string; qty: number }[]): string =>
  createHash('sha256')
    .update(
      [...lines]
        .map((l) => `${l.variantId}:${String(l.qty)}`)
        .sort()
        .join(','),
    )
    .digest('hex')
    .slice(0, 16);

const CORE_RULES: Readonly<Record<string, Rule>> = {
  'order.placed.v1': {
    needsOrder: false,
    build: (event) => {
      const d = event.data as OrderPlacedV1;
      const order = { orderId: d.orderId, orderNo: d.orderNo, userId: d.userId };
      return [
        buyer(event, order, {
          dedupeKey: `order.placed:${d.orderId}`,
          category: 'ORDER',
          templateKey: 'order.placed',
          channels: ['PUSH'],
          vars: { orderNo: d.orderNo, amount: d.grandTotal, payBy: d.paymentDueAt },
        }),
      ];
    },
  },
  'payment.captured.v1': {
    needsOrder: true,
    build: (event, order) => {
      const d = event.data as PaymentCapturedV1;
      return [
        buyer(event, must(order, event), {
          dedupeKey: `payment.captured:${d.paymentId}`,
          category: 'PAYMENT',
          templateKey: 'payment.captured',
          channels: ['PUSH', 'EMAIL'],
          vars: { orderNo: d.orderNo, amount: paise(d.amountPaise) },
        }),
      ];
    },
  },
  'payment.failed.v1': {
    needsOrder: true,
    build: (event, order) => {
      const d = event.data as PaymentFailedV1;
      const o = must(order, event);
      return [
        buyer(event, o, {
          dedupeKey: `payment.failed:${d.paymentId}`,
          category: 'PAYMENT',
          templateKey: 'payment.failed',
          channels: ['PUSH'],
          vars: { orderNo: o.orderNo },
        }),
      ];
    },
  },
  'order.confirmed.v1': {
    needsOrder: true,
    build: (event, order) => {
      const d = event.data as OrderConfirmedV1;
      return [
        buyer(event, must(order, event), {
          dedupeKey: `order.confirmed:${d.orderId}`,
          category: 'ORDER',
          templateKey: 'order.confirmed',
          channels: ['PUSH', 'EMAIL'],
          vars: { orderNo: d.orderNo },
        }),
      ];
    },
  },
  'order.rejected.v1': {
    needsOrder: true,
    build: (event, order) => {
      const d = event.data as OrderStockReleaseV1;
      return [
        buyer(event, must(order, event), {
          dedupeKey: `order.rejected:${d.orderId}`,
          category: 'ORDER',
          priority: 'HIGH',
          templateKey: 'order.rejected',
          channels: ['PUSH', 'EMAIL', 'SMS'],
          vars: { orderNo: d.orderNo },
        }),
      ];
    },
  },
  'order.failed.v1': {
    needsOrder: true,
    build: (event, order) => {
      const d = event.data as OrderStockReleaseV1;
      // ORDER_CLOSED is a stock-release resend for an order that is ALREADY closed (cancelled,
      // rejected or failed): the buyer was told when it closed.
      if (d.reasonCode === 'ORDER_CLOSED') return [];
      return [
        buyer(event, must(order, event), {
          dedupeKey: `order.failed:${d.orderId}`,
          category: 'ORDER',
          priority: 'HIGH',
          templateKey: 'order.failed',
          channels: ['PUSH', 'EMAIL', 'SMS'],
          vars: {
            orderNo: d.orderNo,
            reason: FAILURE_TEXT[d.reasonCode] ?? 'we could not complete it',
          },
        }),
      ];
    },
  },
  'order.cancelled.v1': {
    needsOrder: true,
    build: (event, order) => {
      const d = event.data as OrderStockReleaseV1;
      const full = d.scope === 'FULL';
      return [
        buyer(event, must(order, event), {
          dedupeKey: full
            ? `order.cancelled:${d.orderId}`
            : `order.cancelled:${d.orderId}:${linesKey(d.lines)}`,
          category: 'ORDER',
          templateKey: full ? 'order.cancelled' : 'order.partially_cancelled',
          channels: ['PUSH', 'EMAIL'],
          vars: { orderNo: d.orderNo },
        }),
      ];
    },
  },
  'payment.refund_initiated.v1': {
    needsOrder: true,
    build: (event, order) => {
      const d = event.data as RefundInitiatedV1;
      const o = must(order, event);
      return [
        buyer(event, o, {
          dedupeKey: `refund.initiated:${d.refundId}`,
          category: 'REFUND',
          templateKey: 'refund.initiated',
          channels: ['PUSH', 'EMAIL'],
          vars: { orderNo: o.orderNo, amount: paise(d.amountPaise), expectedBy: d.expectedBy },
        }),
      ];
    },
  },
  'payment.refund_processed.v1': {
    needsOrder: true,
    build: (event, order) => {
      const d = event.data as RefundProcessedV1;
      const o = must(order, event);
      return [
        buyer(event, o, {
          dedupeKey: `refund.processed:${d.refundId}`,
          category: 'REFUND',
          templateKey: 'refund.processed',
          channels: ['PUSH', 'EMAIL'],
          vars: { orderNo: o.orderNo, amount: paise(d.amountPaise) },
        }),
      ];
    },
  },
  'payment.refund_failed.v1': {
    needsOrder: true,
    build: (event, order) => {
      const d = event.data as RefundFailedV1;
      const o = must(order, event);
      return [
        {
          ...base(event),
          dedupeKey: `refund.failed:${d.refundId}`,
          category: 'REFUND',
          priority: 'HIGH',
          app: 'ADMIN',
          audience: { kind: 'permission', permission: 'refunds.approve' },
          channels: ['PUSH'],
          templateKey: 'refund.failed',
          vars: { orderNo: o.orderNo, amount: paise(d.amountPaise), reason: d.reason },
          entityType: 'refund',
          entityId: d.refundId,
          data: { entityType: 'refund', entityId: d.refundId, orderId: d.orderId },
        },
      ];
    },
  },
  'order.review_overdue.v1': {
    needsOrder: false,
    build: (event) => {
      const d = event.data as OrderReviewOverdueV1;
      return [
        {
          ...base(event),
          dedupeKey: `order.review_overdue:${d.orderId}`,
          category: 'ORDER',
          priority: 'HIGH',
          app: 'ADMIN',
          audience: { kind: 'permission', permission: 'orders.confirm' },
          channels: ['PUSH'],
          templateKey: 'order.review_overdue',
          vars: { orderNo: d.orderNo, waitingMinutes: d.waitingMinutes },
          entityType: 'order',
          entityId: d.orderId,
          data: { entityType: 'order', entityId: d.orderId, orderNo: d.orderNo },
        },
      ];
    },
  },
  'inventory.low_stock.v1': {
    needsOrder: false,
    build: (event) => {
      const d = event.data as LowStockV1;
      return [
        {
          ...base(event),
          dedupeKey: `inventory.low_stock:${event.id}`,
          category: 'INVENTORY',
          priority: 'NORMAL',
          app: 'WAREHOUSE',
          audience: {
            kind: 'permission',
            permission: 'inventory.view',
            warehouseId: d.warehouseId,
          },
          channels: ['PUSH'],
          templateKey: 'inventory.low_stock',
          vars: { availableQty: d.availableQty, threshold: d.threshold },
          entityType: 'variant',
          entityId: d.variantId,
          data: { entityType: 'variant', entityId: d.variantId, warehouseId: d.warehouseId },
        },
      ];
    },
  },
};

// ── Content (farm-service): readers resolved page by page from farm-service by the fan-out ──

/**
 * CRITICAL alerts are mandatory (opt-outs ignored: animal-health safety); WARNING alerts,
 * corrections of alerts and withdrawals are HIGH (bypass the daily content cap); the rest NORMAL.
 */
const contentPriority = (
  d: ContentEventBaseV1,
  kind: 'published' | 'corrected' | 'retracted',
): NotificationPriority => {
  if (d.severity === 'CRITICAL') return 'CRITICAL';
  if (kind === 'retracted' || d.kind === 'ALERT') return 'HIGH';
  return 'NORMAL';
};

const contentDraft = (
  event: EventEnvelope,
  d: ContentEventBaseV1,
  kind: 'published' | 'corrected' | 'retracted',
  scope: ContentAudienceScope,
  templateKey: string,
  vars: NotificationDraft['vars'],
): NotificationDraft => ({
  ...base(event),
  // Business key: redelivery or a re-emit with a new event id never notifies twice.
  dedupeKey: `content.${kind}:${d.contentId}:v${String(d.contentVersion)}`,
  category: 'CONTENT',
  priority: contentPriority(d, kind),
  app: 'CUSTOMER',
  audience: { kind: 'farmContent', contentId: d.contentId, scope },
  channels: ['PUSH'],
  templateKey,
  vars,
  entityType: 'content',
  entityId: d.contentId,
  data: { entityType: 'content', entityId: d.contentId, contentVersion: d.contentVersion },
});

const CONTENT_RULES: Readonly<Record<string, Rule>> = {
  'content.published.v1': {
    needsOrder: false,
    build: (event) => {
      const d = event.data as ContentPublishedV1;
      return [
        contentDraft(
          event,
          d,
          'published',
          'segment',
          d.kind === 'ALERT' ? 'content.alert' : 'content.news',
          { title: d.title, summary: d.summary },
        ),
      ];
    },
  },
  'content.corrected.v1': {
    needsOrder: false,
    build: (event) => {
      const d = event.data as ContentCorrectedV1;
      return [
        contentDraft(event, d, 'corrected', 'both', 'content.corrected', {
          title: d.title,
          note: d.correctionNote,
        }),
      ];
    },
  },
  'content.retracted.v1': {
    needsOrder: false,
    build: (event) => {
      const d = event.data as ContentRetractedV1;
      return [
        contentDraft(
          event,
          d,
          'retracted',
          d.wasNotified ? 'both' : 'savers',
          'content.retracted',
          {
            title: d.title,
            note: d.retractNote,
          },
        ),
      ];
    },
  },
};
export const RULES: Readonly<Record<string, Rule>> = { ...CORE_RULES, ...CONTENT_RULES, ...SUPPORT_RULES };

/** Routing keys the consumer queue binds. */
export const EVENT_BINDINGS: readonly string[] = Object.keys(RULES);
