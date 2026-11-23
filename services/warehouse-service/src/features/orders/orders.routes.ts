import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync } from 'fastify';

import { callerOf, staffRead } from '../../middleware/guards.js';
import { ORDER_DOCS } from './orders.docs.js';
import type { OrderListQuery } from './orders.types.js';
import { listOrdersSchema } from './orders.validation.js';

/** Mounted at `/admin/warehouses`: W2.03 Active Orders tab. */
export const ordersRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string }; Querystring: OrderListQuery }>(
    '/:id/orders',
    {
      schema: { ...listOrdersSchema, ...routeDocs(ORDER_DOCS.list) },
      preHandler: staffRead('warehouse.view'),
    },
    async (req) => {
      const page = await req.diScope
        .resolve('ordersService')
        .list(callerOf(req), req.params.id, req.query);
      return {
        success: true,
        data: page.items,
        meta: { nextCursor: page.nextCursor, limit: page.limit, total: page.total },
      };
    },
  );
};
