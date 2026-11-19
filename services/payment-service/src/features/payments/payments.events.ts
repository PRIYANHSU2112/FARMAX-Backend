import type { OrderStockReleaseV1 } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { EventHandlerMap } from '../../adapters/events.js';

/** order.rejected | cancelled | failed → void the order's open payment (inside the inbox tx). */
export const createPaymentEventHandlers = ({
  paymentsService: svc,
}: Pick<Cradle, 'paymentsService'>): EventHandlerMap => {
  const closed: NonNullable<EventHandlerMap[string]> = async (event, tx) => {
    const d = event.data as OrderStockReleaseV1;
    // A partial cancel keeps the order (and its payment) alive.
    if (d.scope !== 'FULL') return;
    await svc.onOrderClosedInTx(tx, d.orderId, d.reasonCode);
  };
  return {
    'order.rejected.v1': closed,
    'order.cancelled.v1': closed,
    'order.failed.v1': closed,
  };
};
