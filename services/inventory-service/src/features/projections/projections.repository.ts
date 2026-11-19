import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

export interface VariantFactsRow {
  variantId: string;
  productId: string;
  sku: string;
  name: string;
  isActive: boolean;
  temperatureClass: string;
}

/** Only place that touches `inventory_variant_projections` (written by product events only). */
export class ProjectionsRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** Newer snapshot wins: (version, occurredAt) must be greater than what is stored. */
  async upsertVariant(tx: Tx, f: VariantFactsRow, version: number, at: Date): Promise<boolean> {
    const n = await tx.$executeRaw`
      INSERT INTO "inventory_variant_projections"
        ("variantId", "productId", "sku", "name", "isActive", "temperatureClass", "factsVersion",
         "factsAt", "updatedAt")
      VALUES (${f.variantId}::uuid, ${f.productId}::uuid, ${f.sku}, ${f.name}, ${f.isActive},
         ${f.temperatureClass}, ${version}, ${at}, now())
      ON CONFLICT ("variantId") DO UPDATE SET
        "productId" = EXCLUDED."productId", "sku" = EXCLUDED."sku", "name" = EXCLUDED."name",
        "isActive" = EXCLUDED."isActive", "temperatureClass" = EXCLUDED."temperatureClass",
        "factsVersion" = EXCLUDED."factsVersion", "factsAt" = EXCLUDED."factsAt", "updatedAt" = now()
      WHERE "inventory_variant_projections"."factsVersion" < EXCLUDED."factsVersion"
         OR ("inventory_variant_projections"."factsVersion" = EXCLUDED."factsVersion"
             AND ("inventory_variant_projections"."factsAt" IS NULL
                  OR "inventory_variant_projections"."factsAt" < EXCLUDED."factsAt"))`;
    return n === 1;
  }

  async deactivate(tx: Tx, variantId: string, version: number, at: Date): Promise<boolean> {
    const n = await tx.$executeRaw`
      UPDATE "inventory_variant_projections"
      SET "isActive" = false, "factsVersion" = ${version}, "factsAt" = ${at}, "updatedAt" = now()
      WHERE "variantId" = ${variantId}::uuid AND "factsVersion" <= ${version}`;
    return n === 1;
  }

  findMany(ids: readonly string[], tx?: Tx): Promise<VariantFactsRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return withPrismaErrors(() =>
      (tx ?? this.db).inventoryVariantProjection.findMany({
        where: { variantId: { in: [...ids] } },
        select: {
          variantId: true,
          productId: true,
          sku: true,
          name: true,
          isActive: true,
          temperatureClass: true,
        },
      }),
    );
  }
}
