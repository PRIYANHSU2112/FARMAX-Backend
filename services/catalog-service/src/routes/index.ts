import type { DocsOptions, ServiceModule } from '@farmx/common/server';

import type { CatalogConfig } from '../config/index.js';
import { auditModule } from '../features/audit/index.js';
import {
  ADMIN_BANNERS_TAG,
  BANNERS_TAG,
  bannerPlacementsAdminModule,
  bannersAdminModule,
  bannersModule,
} from '../features/banners/index.js';
import {
  ADMIN_BRANDS_TAG,
  BRANDS_TAG,
  brandsAdminModule,
  brandsInternalModule,
  brandsModule,
} from '../features/brands/index.js';
import {
  ADMIN_CATEGORIES_TAG,
  CATEGORIES_TAG,
  categoriesAdminModule,
  categoriesInternalModule,
  categoriesModule,
} from '../features/categories/index.js';

/**
 * Every feature of catalog-service. The gateway maps `/v1/catalog/*` → `/catalog/*` and
 * `/v1/admin/catalog/*` → `/admin/catalog/*`; `/v1/catalog-service/health` → `/health`.
 *   /catalog/categories/*         categories (public storefront)
 *   /admin/catalog/categories/*   categories-admin
 *   /catalog/brands/*             brands (public storefront)
 *   /admin/catalog/brands/*       brands-admin
 *   /catalog/banners/*            banners (public storefront)
 *   /admin/catalog/banners/*      banners-admin
 *   /admin/catalog/banner-placements/*  banner-placements-admin
 *   /internal/catalog/*           internal (product-service; never routed by the gateway)
 */
export const features: readonly ServiceModule[] = [
  auditModule,
  categoriesModule,
  categoriesAdminModule,
  brandsModule,
  brandsAdminModule,
  bannersModule,
  bannersAdminModule,
  bannerPlacementsAdminModule,
  categoriesInternalModule,
  brandsInternalModule,
];

/** Spec only (`/api-docs.json`); the gateway merges it into the single FarmX Swagger UI. */
export const createDocsOptions = (config: CatalogConfig): DocsOptions => ({
  title: 'FarmX Catalog Service API',
  version: config.SERVICE_VERSION,
  description:
    'Product catalogue: category tree (categories and sub-categories, any depth) and brands. Public storefront reads are cache-first with ETag / 304.',
  tags: [
    { name: 'Health', description: 'Public liveness and readiness probes.' },
    {
      name: CATEGORIES_TAG,
      description: 'Storefront: category tree, category pages, sub-categories.',
    },
    {
      name: ADMIN_CATEGORIES_TAG,
      description: 'Admin: create, edit, move, reorder and delete categories (audited).',
    },
    {
      name: BRANDS_TAG,
      description: 'Storefront: brand list, search, featured brands, brand page.',
    },
    {
      name: ADMIN_BRANDS_TAG,
      description:
        'Admin: create, edit, activate/feature and delete brands (`catalogue.manage`, audited).',
    },
    {
      name: BANNERS_TAG,
      description: 'Storefront: live banners per app / page / position or by placement code.',
    },
    {
      name: ADMIN_BANNERS_TAG,
      description:
        'Admin: dynamic placements (slots) and scheduled banners — create, edit, reorder, activate, delete (`catalogue.manage`, audited).',
    },
  ],
});
