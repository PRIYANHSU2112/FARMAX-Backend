import type { Tx } from '@farmx/database';
import type { EventEnvelope, UserProfileUpdatedV1 } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { EventHandlers } from '../../adapters/events.js';

type Deps = Pick<Cradle, 'farmsService'>;

/**
 * auth-service account events (inbox: a redelivered event is a no-op).
 *   user.profile_updated.v1  Contact screen / mobile change → owner name + phone snapshot on
 *                            every farm of that user; caches are dropped after commit.
 */
export const createFarmEventHandlers = (deps: Deps): EventHandlers => ({
  inTx: {
    'user.profile_updated.v1': async (event: EventEnvelope, tx: Tx) => {
      const data = event.data as UserProfileUpdatedV1;
      if (!data.changedFields.includes('fullName') && !data.changedFields.includes('phone')) return;
      await deps.farmsService.syncOwnerContactInTx(tx, data.userId, {
        fullName: data.fullName,
        phone: data.phone,
      });
    },
  },
  afterCommit: {
    'user.profile_updated.v1': (event: EventEnvelope) =>
      deps.farmsService.invalidateOwner((event.data as UserProfileUpdatedV1).userId),
  },
});
