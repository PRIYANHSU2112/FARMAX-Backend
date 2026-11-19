import { startService } from '@farmx/common/server';

import { createServiceOptions } from './app.js';

try {
  const options = createServiceOptions();
  const app = await startService(options);
  // Outbox relay + event consumer run only in the real process (tests use buildApp, no AMQP).
  if (options.container.cradle.config.EVENTS_ENABLED)
    app.diContainer.resolve('eventsRuntime').start();
} catch (error) {
  // Logger may not exist yet (e.g. invalid config), so write straight to stderr.
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}
`);
  process.exit(1);
}
