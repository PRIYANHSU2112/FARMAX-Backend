import type { Tx } from '@farmx/database';
import type { EventEnvelope, OrderPlacedV1 } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { Accepted } from '../notifications/index.js';
import { RULES } from './events.rules.js';

type Deps = Pick<Cradle, 'audienceService' | 'notificationsService'>;

/** Turns one business event into notifications, inside the inbox transaction (DB work only). */
export class EventsService {
  constructor(private readonly deps: Deps) {}

  handles(type: string): boolean {
    return RULES[type] !== undefined;
  }

  /** Returns what was created (duplicates by dedupe key are left out). */
  async handle(event: EventEnvelope, tx: Tx): Promise<Accepted[]> {
    const rule = RULES[event.type];
    if (rule === undefined) return [];
    const { audienceService, notificationsService } = this.deps;
    if (event.type === 'order.placed.v1') {
      const d = event.data as OrderPlacedV1;
      await audienceService.recordOrder(tx, {
        orderId: d.orderId,
        orderNo: d.orderNo,
        userId: d.userId,
      });
    }
    const orderId = (event.data as { orderId?: unknown }).orderId;
    const order =
      rule.needsOrder && typeof orderId === 'string'
        ? await audienceService.findOrder(orderId, tx)
        : null;
    const accepted: Accepted[] = [];
    for (const draft of rule.build(event, order)) {
      const result = await notificationsService.accept(tx, draft);
      if (result !== null) accepted.push(result);
    }
    return accepted;
  }
}
