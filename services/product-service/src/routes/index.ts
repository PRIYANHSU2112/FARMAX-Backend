import type { DocsOptions, ServiceModule } from '@farmx/common/server';

import type { ProductConfig } from '../config/index.js';
import {
  ADMIN_ATTRIBUTES_TAG,
  attributesModule,
  complianceModule,
} from '../features/attributes/index.js';
import { auditModule } from '../features/audit/index.js';
import {
  ADMIN_DISEASES_TAG,
  ADMIN_LOOKUPS_TAG,
  ADMIN_PRODUCTS_TAG,
  DISEASES_TAG,
  LOOKUPS_TAG,
  PRODUCTS_TAG,
  diseasesAdminModule,
  diseasesModule,
  lookupsAdminModule,
  lookupsModule,
  productsAdminModule,
  productsInternalModule,
  productsModule,
} from '../features/products/index.js';
import {
  ADMIN_REVIEWS_TAG,
  MY_REVIEWS_TAG,
  REVIEWS_TAG,
  reviewsAdminModule,
  reviewsCustomerModule,
  reviewsModule,
} from '../features/reviews/index.js';

/**
 * Every feature of product-service. The gateway maps (narrow prefixes, before `/v1/catalog`):
 *   /v1/catalog/products/*                    → /catalog/products/*      storefront
 *   /v1/catalog/lookups                       → /catalog/lookups         storefront
 *   /v1/catalog/diseases                      → /catalog/diseases        storefront (Shop by Problem)
 *   /v1/admin/catalog/products/*              → /admin/catalog/products/*
 *   /v1/admin/catalog/lookups/*               → /admin/catalog/lookups/*
 *   /v1/admin/catalog/diseases/*              → /admin/catalog/diseases/*
 *   /v1/admin/catalog/product-attributes/*    → /admin/catalog/product-attributes/*
 *   /v1/admin/catalog/compliance-profiles/*   → /admin/catalog/compliance-profiles/*
 *   /v1/catalog/products/:slugOrId/reviews    → reviews (same prefix as the products storefront)
 *   /v1/catalog/reviews/*                     → /catalog/reviews/*        customer
 *   /v1/admin/catalog/reviews/*               → /admin/catalog/reviews/*
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
  diseasesModule,
  diseasesAdminModule,
  reviewsModule,
  reviewsCustomerModule,
  reviewsAdminModule,
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
    {
      name: LOOKUPS_TAG,
      description: 'Storefront: dosage forms, routes, species, units, flock stages.',
    },
    {
      name: DISEASES_TAG,
      description: 'Storefront: "Shop by Problem" disease cards with visible product counts.',
    },
    {
      name: ADMIN_PRODUCTS_TAG,
      description:
        'Admin: products, variants, media, review/publish workflow (`catalogue.manage`, `catalogue.publish`).',
    },
    { name: ADMIN_LOOKUPS_TAG, description: 'Admin: dynamic master values (`catalogue.manage`).' },
    {
      name: ADMIN_DISEASES_TAG,
      description: 'Admin: disease / problem master for Shop by Problem (`catalogue.manage`).',
    },
    {
      name: REVIEWS_TAG,
      description: 'Storefront: verified-purchase reviews and the rating summary of a product.',
    },
    {
      name: MY_REVIEWS_TAG,
      description:
        'Customer: products to review, write / edit / delete my review, helpful votes, reports.',
    },
    {
      name: ADMIN_REVIEWS_TAG,
      description:
        'Admin: moderation queue, search, approve / reject / hide / restore, reported content, analytics, audit (`reviews.view`, `reviews.moderate`).',
    },
    {
      name: ADMIN_ATTRIBUTES_TAG,
      description: 'Admin: per-category attributes and compliance profiles (`catalogue.manage`).',
    },
  ],
});
