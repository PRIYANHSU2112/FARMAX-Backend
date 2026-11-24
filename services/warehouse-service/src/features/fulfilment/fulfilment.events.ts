import type {
  IssueRejectedV1,
  OrderConfirmedV1,
  OrderDeliveryUpdatedV1,
  OrderPaidV1,
  OrderPlacedV1,
  OrderStockReleaseV1,
  ReservationCommittedV1,
  ReservationReleasedV1,
} from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { EventHandlerMap } from '../../adapters/events.js';

/** Order + reservation events → fulfilment read model and shipments (inbox transaction). */
export const createFulfilmentEventHandlers = ({
  fulfilmentSync: svc,
  fulfilmentAmendments: amend,
}: Pick<Cradle, 'fulfilmentSync' | 'fulfilmentAmendments'>): EventHandlerMap => {
  const at = (iso: string) => new Date(iso);
  return {
    'order.placed.v1': (e, tx) => svc.applyPlaced(tx, e.data as OrderPlacedV1, at(e.occurredAt)),
    'order.paid.v1': (e, tx) => svc.applyPaid(tx, e.data as OrderPaidV1, at(e.occurredAt)),
    'order.confirmed.v1': (e, tx) =>
      svc.applyConfirmed(tx, e.data as OrderConfirmedV1, at(e.occurredAt)),
    'order.rejected.v1': (e, tx) =>
      svc.applyStopped(tx, e.data as OrderStockReleaseV1, at(e.occurredAt), 'REJECTED'),
    'order.cancelled.v1': (e, tx) =>
      svc.applyStopped(tx, e.data as OrderStockReleaseV1, at(e.occurredAt), 'CANCELLED'),
    'order.failed.v1': (e, tx) =>
      svc.applyStopped(tx, e.data as OrderStockReleaseV1, at(e.occurredAt), 'FAILED'),
    'inventory.reservation_committed.v1': (e, tx) =>
      svc.applyCommitted(tx, e.data as ReservationCommittedV1, at(e.occurredAt)),
    'inventory.reservation_released.v1': (e, tx) =>
      svc.applyReleased(tx, e.data as ReservationReleasedV1),
    'inventory.issue_rejected.v1': (e, tx) => svc.applyIssueRejected(tx, e.data as IssueRejectedV1),
    'order.delivery_updated.v1': (e, tx) =>
      amend.applyDeliveryUpdated(tx, e.data as OrderDeliveryUpdatedV1),
  };
};
