import type { DocsOptions, ServiceModule } from '@farmx/common/server';

import type { ServiceConfig } from '../config/index.js';
import { EXAMPLE_TAG, exampleModule } from '../features/example/index.js';

/**
 * Every feature of this service (no service-level prefix; the gateway maps `/v1/<svc>/*` → `/*`).
 * Health routes (`/health/live`, `/health/ready`) come from @farmx/common/server.
 *   /examples  example   ← replace with your features
 */
export const features: readonly ServiceModule[] = [exampleModule];

/**
 * Spec at `/api-docs.json`, merged into the single gateway Swagger (D-29): also add the new
 * service to `api-gateway/src/features/docs/docs.module.ts`. One tag per feature, in display order.
 */
export const createDocsOptions = (config: ServiceConfig): DocsOptions => ({
  title: 'FarmX Service Template API',
  version: config.SERVICE_VERSION,
  tags: [
    { name: 'Health', description: 'Public liveness and readiness probes.' },
    { name: EXAMPLE_TAG, description: 'Example feature — replace with your own.' },
  ],
});
