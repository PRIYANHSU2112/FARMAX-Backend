// Public API of the refunds feature.
import { defineModule } from '@farmx/common/server';
import type { OrderRefundRequestedV1 } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';
import { asClass, asFunction } from 'awilix';

import type { EventHandlerMap } from '../../adapters/events.js';
import { RefundsRepository } from './refunds.repository.js';
import { refundsAdminRoutes } from './refunds.routes.js';
import { RefundsService } from './refunds.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    refundsRepository: RefundsRepository;
    refundsService: RefundsService;
    refundEventHandlers: EventHandlerMap;
  }
}

/** order.refund_requested.v1 → a refund (inside the inbox transaction; sourceRef dedups). */
const createRefundEventHandlers = ({
  refundsService,
}: Pick<Cradle, 'refundsService'>): EventHandlerMap => ({
  'order.refund_requested.v1': (event, tx) =>
    refundsService.requestInTx(tx, event.data as OrderRefundRequestedV1, event.correlationId),
});

export const refundsModule = defineModule({
  name: 'refunds',
  prefix: '/admin/refunds',
  register: (container) => {
    container.register({
      refundsRepository: asClass(RefundsRepository).singleton(),
      refundsService: asClass(RefundsService).singleton(),
      refundEventHandlers: asFunction(createRefundEventHandlers).singleton(),
    });
  },
  routes: refundsAdminRoutes,
});

export type { RefundsService } from './refunds.service.js';
export { ADMIN_REFUNDS_TAG } from './refunds.routes.js';
