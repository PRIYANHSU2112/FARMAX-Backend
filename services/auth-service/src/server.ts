import { startService } from '@farmx/common/server';

import { createServiceOptions } from './app.js';

const PURGE_EVERY_MS = 60 * 60_000;

try {
  const options = createServiceOptions();
  const app = await startService(options);
  const { config } = options.container.cradle;
  // Outbox relay and the account-purge job run only in the real process (never in tests).
  if (config.EVENTS_ENABLED) app.diContainer.resolve('eventsRuntime').start();
  if (config.JOBS_ENABLED) {
    const purge = () => {
      app.diContainer
        .resolve('deletionService')
        .purgeDue()
        .catch((err: unknown) => {
          app.log.error({ err }, 'account purge failed; retried next hour');
        });
    };
    purge();
    setInterval(purge, PURGE_EVERY_MS).unref();
  }
} catch (error) {
  // Logger may not exist yet (e.g. invalid config), so write straight to stderr.
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}
`);
  process.exit(1);
}
