import type {
  OrderConfirmedV1,
  OrderDeliveredV1,
  OrderPlacedV1,
  OrderStockReleaseV1,
  ReservationCommittedV1,
  ReservationReleasedV1,
} from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { EventHandlerMap } from '../../adapters/events.js';

/** Order + reservation events → warehouse order read model (inside the inbox transaction). */
export const createOrderEventHandlers = ({
  ordersService: svc,
}: Pick<Cradle, 'ordersService'>): EventHandlerMap => {
  const at = (occurredAt: string) => new Date(occurredAt);
  const stopped: NonNullable<EventHandlerMap[string]> = (e, tx) =>
    svc.applyStopped(tx, e.data as OrderStockReleaseV1, at(e.occurredAt));
  return {
    'order.placed.v1': (e, tx) => svc.applyPlaced(tx, e.data as OrderPlacedV1, at(e.occurredAt)),
    'order.confirmed.v1': (e, tx) =>
      svc.applyConfirmed(tx, e.data as OrderConfirmedV1, at(e.occurredAt)),
    'order.delivered.v1': (e, tx) =>
      svc.applyDelivered(tx, e.data as OrderDeliveredV1, at(e.occurredAt)),
    'order.rejected.v1': stopped,
    'order.cancelled.v1': stopped,
    'order.failed.v1': stopped,
    'inventory.reservation_committed.v1': (e, tx) =>
      svc.applyCommitted(tx, e.data as ReservationCommittedV1, at(e.occurredAt)),
    'inventory.reservation_released.v1': (e, tx) =>
      svc.applyReleased(tx, e.data as ReservationReleasedV1, at(e.occurredAt)),
  };
};
