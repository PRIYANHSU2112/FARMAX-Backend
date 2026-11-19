import type { Tx } from '@farmx/database';
import type {
  AvailabilityChangedV1,
  EventEnvelope,
  FarmFactsV1,
  PriceChangedV1,
  VariantDeactivatedV1,
  VariantFactsV1,
} from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { EventHandlerMap } from '../../adapters/events.js';

type Deps = Pick<Cradle, 'projectionsRepository' | 'logger'>;

/** Producers deployed before the order fields were added send facts without them. */
type OrderFields =
  'categoryId' | 'categoryPath' | 'brandId' | 'hsnCode' | 'gstRate' | 'minOrderQty' | 'maxOrderQty';
type VariantFactsWire = Omit<VariantFactsV1, OrderFields> &
  Partial<Pick<VariantFactsV1, OrderFields>>;

/**
 * Consumers that keep order-service's read models in sync. Each runs inside the inbox transaction
 * (a redelivered event id is skipped); the repository drops snapshots older than the stored one.
 */
export const createProjectionEventHandlers = ({
  projectionsRepository: repo,
  logger,
}: Deps): EventHandlerMap => {
  const variantFacts = async (event: EventEnvelope, tx: Tx) => {
    const d = event.data as VariantFactsWire;
    // Producers older than this contract do not send the order fields yet: ignore, wait for the next.
    if (d.categoryId === undefined || d.brandId === undefined) {
      logger.warn(
        { variantId: d.variantId, eventId: event.id },
        'variant facts without category/brand ignored',
      );
      return;
    }
    await repo.upsertVariantFacts(
      tx,
      {
        variantId: d.variantId,
        productId: d.productId,
        sku: d.sku,
        name: `${d.productName} ${d.variantName}`.trim().slice(0, 250),
        categoryId: d.categoryId,
        categoryPath: d.categoryPath ?? [],
        brandId: d.brandId,
        hsnCode: d.hsnCode ?? null,
        gstRate: d.gstRate ?? null,
        temperatureClass: d.temperatureClass,
        isActive: d.isActive,
        minOrderQty: d.minOrderQty ?? 1,
        maxOrderQty: d.maxOrderQty ?? null,
        isPrescriptionRequired: d.isPrescriptionRequired,
      },
      d.version,
      new Date(event.occurredAt),
    );
  };

  return {
    'product.variant_created.v1': variantFacts,
    'product.variant_updated.v1': variantFacts,

    'product.variant_deactivated.v1': async (event, tx) => {
      const d = event.data as VariantDeactivatedV1;
      await repo.deactivateVariant(tx, d.variantId, d.version, new Date(event.occurredAt));
    },

    'pricing.price_changed.v1': async (event, tx) => {
      const d = event.data as PriceChangedV1;
      await repo.upsertPrice(tx, d.variantId, d.sellingPrice, d.sequence);
    },

    'inventory.availability_changed.v1': async (event, tx) => {
      const d = event.data as AvailabilityChangedV1;
      await repo.upsertAvailability(tx, d.variantId, d.availableQty, d.sequence);
    },

    'farm.facts_changed.v1': async (event, tx) => {
      const d = event.data as FarmFactsV1;
      await repo.upsertFarm(
        tx,
        {
          farmId: d.farmId,
          ownerUserId: d.ownerUserId,
          farmCode: d.farmCode,
          name: d.name,
          category: d.category,
          productionTypes: d.productionTypes,
          gstin: d.gstin,
          stateCode: d.stateCode,
          territoryCode: d.territoryCode,
          pinCode: d.pinCode,
          status: d.status,
        },
        d.version,
        new Date(event.occurredAt),
      );
    },
  };
};
