import type { Tx } from '@farmx/database';
import type { EventEnvelope, VariantDeactivatedV1, VariantFactsV1 } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { EventHandlerMap } from '../../adapters/events.js';

/** product events → `inventory_variant_projections` (inside the inbox transaction). */
export const createProjectionEventHandlers = ({
  projectionsRepository: repo,
}: Pick<Cradle, 'projectionsRepository'>): EventHandlerMap => {
  const facts = async (event: EventEnvelope, tx: Tx) => {
    const d = event.data as VariantFactsV1;
    await repo.upsertVariant(
      tx,
      {
        variantId: d.variantId,
        productId: d.productId,
        sku: d.sku,
        name: `${d.productName} ${d.variantName}`.trim().slice(0, 250),
        isActive: d.isActive,
        temperatureClass: d.temperatureClass,
        // Older events may lack the category fields (Partial: read defensively).
        rootCategoryId:
          (d as Partial<VariantFactsV1>).categoryPath?.[0] ??
          (d as Partial<VariantFactsV1>).categoryId ??
          null,
        weightGrams: d.weightGrams ?? null,
      },
      d.version,
      new Date(event.occurredAt),
    );
  };
  return {
    'product.variant_created.v1': facts,
    'product.variant_updated.v1': facts,
    'product.variant_deactivated.v1': async (event, tx) => {
      const d = event.data as VariantDeactivatedV1;
      await repo.deactivate(tx, d.variantId, d.version, new Date(event.occurredAt));
    },
  };
};
