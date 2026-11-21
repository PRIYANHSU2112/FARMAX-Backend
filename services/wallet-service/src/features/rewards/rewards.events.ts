import type { Tx } from '@farmx/database';
import type { EventEnvelope, OrderDeliveredV1, RefundProcessedV1 } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { EventHandlerMap } from '../../adapters/events.js';

/**
 * order.delivered.v1 → earn (PENDING); payment.refund_processed.v1 → pro-rata reversal. Both run
 * inside the inbox transaction and are idempotent (lot per order, journal key per refund).
 */
export const createRewardEventHandlers = ({
  rewardsService,
  logger,
}: Pick<Cradle, 'rewardsService' | 'logger'>): EventHandlerMap => ({
  'order.delivered.v1': (event: EventEnvelope, tx: Tx) => {
    const d = event.data as OrderDeliveredV1;
    if (typeof d.orderId !== 'string' || typeof d.userId !== 'string') {
      logger.warn({ eventId: event.id }, 'malformed order.delivered.v1 ignored');
      return Promise.resolve();
    }
    return rewardsService.earnForOrderInTx(tx, d, event.correlationId);
  },
  'payment.refund_processed.v1': (event: EventEnvelope, tx: Tx) =>
    rewardsService.reverseForRefundInTx(tx, event.data as RefundProcessedV1, event.correlationId),
});
