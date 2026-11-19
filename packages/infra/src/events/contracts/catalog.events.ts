/**
 * Event contracts PUBLISHED by catalog-service (producer-owned, docs/event-contracts.md).
 * Consumers: product-service (brand name snapshot + search text, cache cleanup).
 */
import type { EventEnvelope } from '../envelope.js';

export const CATALOG_EVENT_SOURCE = 'catalog-service';

export const CATALOG_EVENTS = {
  brandUpdated: 'catalog.brand_updated.v1',
  brandDeleted: 'catalog.brand_deleted.v1',
  categoryDeleted: 'catalog.category_deleted.v1',
} as const;

export type CatalogEventType = (typeof CATALOG_EVENTS)[keyof typeof CATALOG_EVENTS];

/** Name, code, slug or active flag changed. `version` = brand row version (monotonic). */
export interface BrandUpdatedV1 {
  brandId: string;
  name: string;
  code: string;
  slug: string;
  isActive: boolean;
  version: number;
}

export interface BrandDeletedV1 {
  brandId: string;
}

export interface CategoryDeletedV1 {
  categoryId: string;
}

export interface CatalogEventMap {
  'catalog.brand_updated.v1': BrandUpdatedV1;
  'catalog.brand_deleted.v1': BrandDeletedV1;
  'catalog.category_deleted.v1': CategoryDeletedV1;
}

export type CatalogEvent<T extends CatalogEventType = CatalogEventType> = EventEnvelope<
  T,
  CatalogEventMap[T]
>;
