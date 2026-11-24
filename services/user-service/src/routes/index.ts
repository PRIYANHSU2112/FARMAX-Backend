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
import { ADMIN_HOME_TAG, HOME_TAG, homeAdminModule, homeModule } from '../features/home/index.js';
import { WISHLIST_TAG, wishlistAdminModule, wishlistModule } from '../features/wishlist/index.js';

/**
 * Every feature of user-service. The gateway maps `/v1/me/addresses|wishlist/*` → `/me/...`,
 * `/v1/admin/customers/*` → `/admin/customers/*`, `/v1/user-service/health` → `/health`.
 *   /me/addresses/*               addresses (customer)
 *   /me/wishlist/*                wishlist (customer)
 *   /admin/customers/*            addresses-admin + wishlist-admin (support, read-only)
 *   /home/*                       home SDUI layout, sections, feeds (public, optional auth; D-59)
 *   /admin/home/*                 home layouts CMS (`home_layout.*`)
 *   /internal/users/*             addresses-internal (order-service; never routed by the gateway)
 */
export const features: readonly ServiceModule[] = [
  auditModule,
  addressesModule,
  wishlistModule,
  addressesAdminModule,
  wishlistAdminModule,
  addressesInternalModule,
  homeModule,
  homeAdminModule,
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
      name: HOME_TAG,
      description:
        'Server-driven Home and All Categories pages: layout (first paint), product sections, live feeds. Never fails on auth.',
    },
    {
      name: ADMIN_HOME_TAG,
      description:
        'Layouts CMS: drafts, preview, reference check, publish / schedule / rollback (`home_layout.*`).',
    },
    {
      name: ADMIN_CUSTOMERS_TAG,
      description:
        'Support: a customer’s addresses, address history and wishlist (`customers.view`).',
    },
  ],
});
