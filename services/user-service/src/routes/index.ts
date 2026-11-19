import type { DocsOptions, ServiceModule } from '@farmx/common/server';

import type { UserConfig } from '../config/index.js';
import { ADMIN_CUSTOMERS_TAG } from '../docs/shared.js';
import {
  ADDRESSES_TAG,
  addressesAdminModule,
  addressesInternalModule,
  addressesModule,
} from '../features/addresses/index.js';
import { auditModule } from '../features/audit/index.js';
import { WISHLIST_TAG, wishlistAdminModule, wishlistModule } from '../features/wishlist/index.js';

/**
 * Every feature of user-service. The gateway maps `/v1/me/addresses|wishlist/*` → `/me/...`,
 * `/v1/admin/customers/*` → `/admin/customers/*`, `/v1/user-service/health` → `/health`.
 *   /me/addresses/*               addresses (customer)
 *   /me/wishlist/*                wishlist (customer)
 *   /admin/customers/*            addresses-admin + wishlist-admin (support, read-only)
 *   /internal/users/*             addresses-internal (order-service; never routed by the gateway)
 */
export const features: readonly ServiceModule[] = [
  auditModule,
  addressesModule,
  wishlistModule,
  addressesAdminModule,
  wishlistAdminModule,
  addressesInternalModule,
];

/** Spec only (`/api-docs.json`); the gateway merges it into the single FarmX Swagger UI. */
export const createDocsOptions = (config: UserConfig): DocsOptions => ({
  title: 'FarmX User Service API',
  version: config.SERVICE_VERSION,
  description:
    'Customer self-service data: saved delivery addresses (one default, audited) and the product wishlist.',
  tags: [
    { name: 'Health', description: 'Public liveness and readiness probes.' },
    {
      name: ADDRESSES_TAG,
      description: 'My delivery addresses: create, edit, set default, delete (audited).',
    },
    { name: WISHLIST_TAG, description: 'My saved products (idempotent add, cursor pages).' },
    {
      name: ADMIN_CUSTOMERS_TAG,
      description:
        'Support: a customer’s addresses, address history and wishlist (`customers.view`).',
    },
  ],
});
