import type { Tx } from '@farmx/database';
import type {
  AvailabilityChangedV1,
  BrandUpdatedV1,
  EventEnvelope,
  PriceChangedV1,
} from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { EventHandlerMap } from '../../adapters/events.js';
import { buildSearchText, priceSummary } from './products.helpers.js';

type Deps = Pick<Cradle, 'productsRepository' | 'productsService' | 'logger'>;

/**
 * Consumers that keep product-service's read-only projections in sync. Each runs inside the inbox
 * transaction (idempotent); stale events lose to newer ones through the producer sequence.
 */
export const createProductEventHandlers = ({
  productsRepository: repo,
  productsService,
  logger,
}: Deps): EventHandlerMap => {
  const refreshPrices = async (tx: Tx, productId: string) => {
    const variants = await repo.pricedVariants(tx, productId);
    await repo.setPriceSummary(
      tx,
      productId,
      priceSummary(
        variants.map((v) => ({
          mrp: v.mrp.toString(),
          sellingPrice: v.price === null ? null : v.price.sellingPrice.toString(),
        })),
      ),
    );
  };

  return {
    'pricing.price_changed.v1': async (event: EventEnvelope, tx: Tx) => {
      const data = event.data as PriceChangedV1;
      const variant = await repo.variantExists(tx, data.variantId);
      if (variant === null) {
        logger.warn({ variantId: data.variantId }, 'price for unknown variant ignored');
        return;
      }
      const changed = await repo.upsertPrice(
        tx,
        data.variantId,
        {
          sellingPrice: data.sellingPrice,
          currency: data.currency,
          effectiveFrom: new Date(data.effectiveFrom),
          sourceEventId: event.id,
        },
        data.sequence,
      );
      if (changed) {
        await refreshPrices(tx, variant.productId);
        await productsService.invalidate([], variant.productId);
      }
    },

    'inventory.availability_changed.v1': async (event: EventEnvelope, tx: Tx) => {
      const data = event.data as AvailabilityChangedV1;
      const variant = await repo.variantExists(tx, data.variantId);
      if (variant === null) return;
      const changed = await repo.upsertAvailability(
        tx,
        data.variantId,
        { availableQty: data.availableQty, inStock: data.inStock, lowStock: data.lowStock },
        data.sequence,
      );
      // Same sequence guard: node rows are replaced only when this event is the newest.
      if (changed && data.byNode !== undefined)
        await repo.replaceNodeAvailability(tx, data.variantId, data.byNode, data.sequence);
      if (changed) await productsService.invalidate([], variant.productId);
    },

    'catalog.brand_updated.v1': async (event: EventEnvelope, tx: Tx) => {
      const data = event.data as BrandUpdatedV1;
      const products = await repo.productsOfBrand(tx, data.brandId);
      for (const p of products) {
        await repo.setSearchFields(tx, p.id, {
          brandName: data.name,
          searchText: buildSearchText({
            name: p.name,
            genericName: p.genericName,
            brandName: data.name,
            productCode: p.productCode,
            manufacturerName: p.manufacturerName,
            tags: p.tags,
            ingredientNames: p.ingredients.map((i) => i.name),
          }),
        });
      }
      if (products.length > 0) await productsService.invalidate(products.map((p) => p.slug));
    },
  };
};
