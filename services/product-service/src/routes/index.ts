import type { DocsOptions, ServiceModule } from '@farmx/common/server';

import type { ProductConfig } from '../config/index.js';
import {
  ADMIN_ATTRIBUTES_TAG,
  attributesModule,
  complianceModule,
} from '../features/attributes/index.js';
import { auditModule } from '../features/audit/index.js';
import {
  ADMIN_LOOKUPS_TAG,
  ADMIN_PRODUCTS_TAG,
  LOOKUPS_TAG,
  PRODUCTS_TAG,
  lookupsAdminModule,
  lookupsModule,
  productsAdminModule,
  productsInternalModule,
  productsModule,
} from '../features/products/index.js';

/**
 * Every feature of product-service. The gateway maps (narrow prefixes, before `/v1/catalog`):
 *   /v1/catalog/products/*                    → /catalog/products/*      storefront
 *   /v1/catalog/lookups                       → /catalog/lookups         storefront
 *   /v1/admin/catalog/products/*              → /admin/catalog/products/*
 *   /v1/admin/catalog/lookups/*               → /admin/catalog/lookups/*
 *   /v1/admin/catalog/product-attributes/*    → /admin/catalog/product-attributes/*
 *   /v1/admin/catalog/compliance-profiles/*   → /admin/catalog/compliance-profiles/*
 *   /internal/products/*                      never routed (D-27)
 */
export const features: readonly ServiceModule[] = [
  auditModule,
  attributesModule,
  complianceModule,
  productsModule,
  productsAdminModule,
  productsInternalModule,
  lookupsModule,
  lookupsAdminModule,
];

/** Spec only (`/api-docs.json`); the gateway merges it into the single FarmX Swagger UI. */
export const createDocsOptions = (config: ProductConfig): DocsOptions => ({
  title: 'FarmX Product Service API',
  version: config.SERVICE_VERSION,
  description:
    'Products, pack-size variants, active ingredients, regulatory data (schedules, licences, withdrawal periods, storage classes), media, dynamic master values, per-category attributes and compliance profiles. Selling price and stock are read-only projections of pricing-service and inventory-service.',
  tags: [
    { name: 'Health', description: 'Public liveness and readiness probes.' },
    {
      name: PRODUCTS_TAG,
      description: 'Storefront: browse, search, filter, product page, alternatives.',
    },
    { name: LOOKUPS_TAG, description: 'Storefront: dosage forms, routes, species, units.' },
    {
      name: ADMIN_PRODUCTS_TAG,
      description:
        'Admin: products, variants, media, review/publish workflow (`catalogue.manage`, `catalogue.publish`).',
    },
    { name: ADMIN_LOOKUPS_TAG, description: 'Admin: dynamic master values (`catalogue.manage`).' },
    {
      name: ADMIN_ATTRIBUTES_TAG,
      description: 'Admin: per-category attributes and compliance profiles (`catalogue.manage`).',
    },
  ],
});
