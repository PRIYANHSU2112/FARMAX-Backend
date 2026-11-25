import type { Tx } from '@farmx/database';
import type { EventEnvelope, UserDeletedV1 } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { EventHandlerMap } from '../../adapters/events.js';

type Deps = Pick<Cradle, 'companyRepository' | 'mediaClient' | 'logger'>;

/**
 * auth-service user lifecycle (inbox: a redelivered event is a no-op).
 *   user.deleted.v1  DPDP: delete the applicant's uploaded files and their applications.
 */
export const createCompanyEventHandlers = (deps: Deps): EventHandlerMap => ({
  'user.deleted.v1': async (event: EventEnvelope, tx: Tx) => {
    const { userId } = event.data as UserDeletedV1;
    const keys = await deps.companyRepository.attachmentKeysOf(userId);
    await deps.mediaClient.remove(keys); // idempotent; a failure retries the whole event
    const deleted = await deps.companyRepository.deleteApplicationsOf(tx, userId);
    if (deleted > 0)
      deps.logger.info(
        { userId, applications: deleted, files: keys.length },
        'company applications deleted for deleted user',
      );
  },
});
