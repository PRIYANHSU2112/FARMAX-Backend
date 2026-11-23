import type { Tx } from '@farmx/database';
import type { EventEnvelope, UserDeletedV1, UserStatusChangedV1 } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { EventHandlerMap } from '../../adapters/events.js';

type Deps = Pick<
  Cradle,
  'ticketsRepository' | 'agentsService' | 'mediaClient' | 'realtimeHub' | 'logger'
>;

/**
 * auth-service user lifecycle (inbox: a redelivered event is a no-op).
 *   user.deleted.v1         DPDP: delete the requester's files, scrub their text / phone / name,
 *                           close their open tickets (agent loads released), close their sockets.
 *   user.status_changed.v1  not ACTIVE any more → close their sockets on every replica.
 */
export const createTicketEventHandlers = (deps: Deps): EventHandlerMap => ({
  'user.deleted.v1': async (event: EventEnvelope, tx: Tx) => {
    const { userId } = event.data as UserDeletedV1;
    const keys = await deps.ticketsRepository.attachmentKeysOf(userId);
    await deps.mediaClient.remove(keys); // idempotent; a failure retries the whole event
    for (const t of await deps.ticketsRepository.activeTicketsOf(tx, userId))
      await deps.agentsService.adjustLoad(tx, t.assigneeId, -1);
    const scrubbed = await deps.ticketsRepository.scrubRequester(tx, userId);
    deps.realtimeHub.kickUser(userId, 'account deleted');
    deps.logger.info(
      { userId, tickets: scrubbed, files: keys.length },
      'support data scrubbed for deleted user',
    );
  },
  'user.status_changed.v1': (event: EventEnvelope) => {
    const { userId, status } = event.data as UserStatusChangedV1;
    if (status !== 'ACTIVE') deps.realtimeHub.kickUser(userId, `account ${status.toLowerCase()}`);
    return Promise.resolve();
  },
});
