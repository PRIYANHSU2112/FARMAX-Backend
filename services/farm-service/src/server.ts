import { startService } from '@farmx/common/server';

import { createServiceOptions } from './app.js';

try {
  const options = createServiceOptions();
  const app = await startService(options);
  // BullMQ jobs run only in the real process (tests use buildApp).
  if (options.container.cradle.config.JOBS_ENABLED)
    await app.diContainer.resolve('jobsRuntime').start();
} catch (error) {
  // Logger may not exist yet (e.g. invalid config), so write straight to stderr.
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}
`);
  process.exit(1);
}
