import { startService } from '@farmx/common/server';

import { createServiceOptions } from './app.js';

try {
  const options = createServiceOptions();
  const app = await startService(options);
  const { config } = options.container.cradle;
  // Outbox relay, event consumer and BullMQ jobs run only in the real process (tests never touch
  // AMQP or BullMQ).
  if (config.EVENTS_ENABLED) app.diContainer.resolve('eventsRuntime').start();
  if (config.JOBS_ENABLED) await app.diContainer.resolve('jobsRuntime').start();
} catch (error) {
  // Logger may not exist yet (e.g. invalid config), so write straight to stderr.
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}
`);
  process.exit(1);
}
