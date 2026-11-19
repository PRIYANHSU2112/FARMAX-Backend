import type { Tx } from '@farmx/database';
import type { EventEnvelope, OrderPaidV1, OrderStockReleaseV1 } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { EventHandlerMap } from '../../adapters/events.js';

/**
 * order events → reservation lifecycle (inside the inbox transaction, so a redelivery is a no-op).
 * order.paid → commit (or recovery / reject); order.rejected | cancelled | failed → release.
 */
export const createReservationEventHandlers = ({
  reservationsService: svc,
}: Pick<Cradle, 'reservationsService'>): EventHandlerMap => {
  const ctx = (e: EventEnvelope) => ({ correlationId: e.correlationId, causationId: e.id });
  const release = (label: string) => async (e: EventEnvelope, tx: Tx) => {
    const d = e.data as OrderStockReleaseV1;
    await svc.releaseInTx(tx, d, ctx(e), { userId: null, reason: `${label}: ${d.reasonCode}` });
  };
  return {
    'order.paid.v1': (e, tx) => svc.commitInTx(tx, e.data as OrderPaidV1, ctx(e)),
    'order.rejected.v1': release('Order rejected'),
    'order.cancelled.v1': release('Order cancelled'),
    'order.failed.v1': release('Order failed'),
  };
};
