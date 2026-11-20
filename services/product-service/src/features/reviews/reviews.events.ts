import type { Tx } from '@farmx/database';
import type { EventEnvelope, OrderDeliveredV1 } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { EventHandlerMap } from '../../adapters/events.js';

type Deps = Pick<Cradle, 'reviewsRepository' | 'logger'>;

/**
 * order.delivered.v1 → one review eligibility per (customer, product, order): the
 * verified-purchase proof. Idempotent (inbox + unique key + skipDuplicates).
 */
export const createReviewEventHandlers = ({
  reviewsRepository: repo,
  logger,
}: Deps): EventHandlerMap => ({
  'order.delivered.v1': async (event: EventEnvelope, tx: Tx) => {
    const data = event.data as OrderDeliveredV1;
    const deliveredAt = new Date(data.deliveredAt);
    if (Number.isNaN(deliveredAt.getTime()) || !Array.isArray(data.lines)) {
      logger.warn({ eventId: event.id }, 'malformed order.delivered.v1 ignored');
      return;
    }
    const added = await repo.addEligibility(
      tx,
      data.lines
        .filter((l) => l.qty > 0)
        .map((l) => ({
          userId: data.userId,
          productId: l.productId,
          variantId: l.variantId,
          orderId: data.orderId,
          orderNo: data.orderNo,
          deliveredAt,
        })),
    );
    logger.debug({ orderId: data.orderId, added }, 'review eligibility recorded');
  },
});
