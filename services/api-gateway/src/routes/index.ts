import type { Logger } from '@farmx/common/logger';
import type { ServiceModule } from '@farmx/common/server';

import { type GatewayConfig, docsEnabled } from '../config/index.js';
import { createDocsModule } from '../features/docs/index.js';
import { createProxyModule } from '../features/proxy/index.js';

/**
 * Every feature of the gateway. Health routes (`/health/live`, `/health/ready`) come from
 * @farmx/common/server.
 *   /api-docs (+ .json)                       docs  → ONE Swagger for every service (D-29)
 *   /v1/auth/*                                proxy → auth-service
 *   /v1/upload · /v1/media/*                  proxy → media-service
 *   /v1/farms/* · /v1/admin/farms/*           proxy → farm-service
 *   /v1/catalog/products|lookups|diseases|reviews, /v1/admin/catalog/products|lookups|diseases|reviews|product-attributes|compliance-profiles → product-service
 *   /v1/catalog/* · /v1/admin/catalog/*       proxy → catalog-service
 */
export const createFeatures = (config: GatewayConfig, logger: Logger): readonly ServiceModule[] => [
  ...(docsEnabled(config) ? [createDocsModule(config, logger)] : []),
  createProxyModule(config),
];
