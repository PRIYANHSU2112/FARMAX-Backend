import type {
  EventEnvelope,
  PaymentCapturedV1,
  PaymentExpiredV1,
  PaymentFailedV1,
  RefundFailedV1,
  RefundInitiatedV1,
  RefundProcessedV1,
  ReservationCommittedV1,
  ReservationRejectedV1,
  ReservationReleasedV1,
} from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { EventHandlerMap } from '../../adapters/events.js';

/** payment + inventory events → order lifecycle (inside the inbox transaction). */
export const createOrderEventHandlers = ({
  orderLifecycle: life,
  transactionsService: ledger,
}: Pick<Cradle, 'orderLifecycle' | 'transactionsService'>): EventHandlerMap => {
  const ctx = (e: EventEnvelope) => ({ correlationId: e.correlationId, causationId: e.id });
  return {
    // Money events: the ledger row is written first (idempotent by key, same transaction), so it
    // exists exactly when the event was processed, whatever the lifecycle then decides.
    'payment.captured.v1': async (e, tx) => {
      await ledger.recordCapture(tx, e);
      await life.onPaymentCaptured(tx, e.data as PaymentCapturedV1, ctx(e));
    },
    'payment.failed.v1': (e, tx) => life.onPaymentFailed(tx, e.data as PaymentFailedV1),
    'payment.expired.v1': (e, tx) => life.onPaymentExpired(tx, e.data as PaymentExpiredV1, ctx(e)),
    'payment.refund_initiated.v1': (e, tx) =>
      life.onRefundInitiated(tx, e.data as RefundInitiatedV1),
    'payment.refund_processed.v1': async (e, tx) => {
      await ledger.recordRefund(tx, e);
      await life.onRefundProcessed(tx, e.data as RefundProcessedV1);
    },
    'payment.refund_failed.v1': (e, tx) => life.onRefundFailed(tx, e.data as RefundFailedV1),
    'inventory.reservation_committed.v1': (e, tx) =>
      life.onReservationCommitted(tx, e.data as ReservationCommittedV1, ctx(e)),
    'inventory.reservation_rejected.v1': (e, tx) =>
      life.onReservationRejected(tx, e.data as ReservationRejectedV1, ctx(e)),
    'inventory.reservation_released.v1': (e, tx) =>
      life.onReservationReleased(tx, e.data as ReservationReleasedV1),
  };
};
