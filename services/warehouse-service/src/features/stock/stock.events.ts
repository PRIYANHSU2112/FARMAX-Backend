import type { VariantDeactivatedV1, VariantFactsV1 } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';
import type { EventHandlerMap } from '../../adapters/events.js';

/** "50" + "KG" → "50 KG"; trims trailing zeros of the decimal pack size. */
const packLabel = (size: string, unit: string): string =>
  `${size.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')} ${unit}`.trim().slice(0, 60);

/** Variant facts → projection row (events and the lazy backfill share it). */
export const projectionRow = (v: VariantFactsV1) => ({
  variantId: v.variantId,
  productId: v.productId,
  sku: v.sku,
  name: v.productName.slice(0, 250),
  variantName: v.variantName.slice(0, 250),
  brandId: v.brandId,
  brandName: v.brandName ?? null,
  categoryId: v.categoryId,
  categoryPath: v.categoryPath,
  rootCategoryId: v.categoryPath[0] ?? v.categoryId,
  packLabel: packLabel(v.packSize, v.packUnit),
  weightGrams: v.weightGrams ?? null,
  temperatureClass: v.temperatureClass,
  shelfLifeMonths: v.shelfLifeMonths,
  imageUrl: v.primaryImageUrl ?? null,
  isPrescriptionRequired: v.isPrescriptionRequired,
  drugSchedule: v.drugSchedule ?? null,
  isAntimicrobial: v.isAntimicrobial ?? false,
  hazardClass: v.hazardClass ?? null,
  isActive: v.isActive,
  version: BigInt(v.version),
  searchText: [v.sku, v.productName, v.variantName, v.brandName ?? '']
    .join(' ')
    .toLowerCase()
    .slice(0, 600),
});

/** product-service variant facts → `warehouse_variant_projection` (version-guarded). */
export const createStockEventHandlers = ({
  stockRepository: repo,
  stockQuality,
}: Pick<Cradle, 'stockRepository' | 'stockQuality'>): EventHandlerMap => {
  const upsert: NonNullable<EventHandlerMap[string]> = async (e, tx) => {
    const v = e.data as VariantFactsV1;
    await repo.upsertVariant(tx, projectionRow(v));
  };
  return {
    // D-60: quality policy, batch read copy, decisions → per-warehouse tasks.
    ...stockQuality.handlers(),
    'product.variant_created.v1': upsert,
    'product.variant_updated.v1': upsert,
    'product.variant_deactivated.v1': async (e, tx) => {
      const v = e.data as VariantDeactivatedV1;
      await repo.deactivateVariant(tx, v.variantId, v.version);
    },
  };
};
