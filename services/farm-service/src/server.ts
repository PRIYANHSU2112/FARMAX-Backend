import { startService } from '@farmx/common/server';

import { createServiceOptions } from './app.js';

try {
  await startService(createServiceOptions());
} catch (error) {
  // Logger may not exist yet (e.g. invalid config), so write straight to stderr.
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}
`);
  process.exit(1);
}
