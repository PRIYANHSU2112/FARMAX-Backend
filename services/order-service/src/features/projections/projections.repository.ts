import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { FarmFacts, VariantFacts } from './projections.types.js';

/**
 * Only place that touches order_variant_projections / order_farm_projections.
 * [R4] Every write is guarded: a snapshot lands only if (version, occurredAt) is NEWER than the
 * stored one, so out-of-order and duplicate deliveries are no-ops (the inbox also de-dups ids).
 */
export class ProjectionsRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  async upsertVariantFacts(
    tx: Tx,
    f: {
      variantId: string;
      productId: string;
      sku: string;
      name: string;
      categoryId: string;
      categoryPath: string[];
      brandId: string;
      hsnCode: string | null;
      gstRate: string | null;
      temperatureClass: string;
      isActive: boolean;
      minOrderQty: number;
      maxOrderQty: number | null;
      isPrescriptionRequired: boolean;
    },
    version: number,
    at: Date,
  ): Promise<boolean> {
    const n = await tx.$executeRaw`
      INSERT INTO "order_variant_projections"
        ("variantId", "productId", "sku", "name", "categoryId", "categoryPath", "brandId", "hsnCode",
         "gstRate", "temperatureClass", "isActive", "minOrderQty", "maxOrderQty",
         "isPrescriptionRequired", "factsVersion", "factsAt", "updatedAt")
      VALUES (${f.variantId}::uuid, ${f.productId}::uuid, ${f.sku}, ${f.name}, ${f.categoryId}::uuid,
         ${f.categoryPath}::uuid[], ${f.brandId}::uuid, ${f.hsnCode}, ${f.gstRate}::numeric,
         ${f.temperatureClass}, ${f.isActive}, ${f.minOrderQty}, ${f.maxOrderQty},
         ${f.isPrescriptionRequired}, ${version}, ${at}, now())
      ON CONFLICT ("variantId") DO UPDATE SET
        "productId" = EXCLUDED."productId", "sku" = EXCLUDED."sku", "name" = EXCLUDED."name",
        "categoryId" = EXCLUDED."categoryId", "categoryPath" = EXCLUDED."categoryPath",
        "brandId" = EXCLUDED."brandId", "hsnCode" = EXCLUDED."hsnCode", "gstRate" = EXCLUDED."gstRate",
        "temperatureClass" = EXCLUDED."temperatureClass", "isActive" = EXCLUDED."isActive",
        "minOrderQty" = EXCLUDED."minOrderQty", "maxOrderQty" = EXCLUDED."maxOrderQty",
        "isPrescriptionRequired" = EXCLUDED."isPrescriptionRequired",
        "factsVersion" = EXCLUDED."factsVersion", "factsAt" = EXCLUDED."factsAt", "updatedAt" = now()
      WHERE "order_variant_projections"."factsVersion" < EXCLUDED."factsVersion"
         OR ("order_variant_projections"."factsVersion" = EXCLUDED."factsVersion"
             AND ("order_variant_projections"."factsAt" IS NULL
                  OR "order_variant_projections"."factsAt" < EXCLUDED."factsAt"))`;
    return n > 0;
  }

  async deactivateVariant(tx: Tx, variantId: string, version: number, at: Date): Promise<boolean> {
    const n = await tx.$executeRaw`
      UPDATE "order_variant_projections"
      SET "isActive" = false, "factsVersion" = ${version}, "factsAt" = ${at}, "updatedAt" = now()
      WHERE "variantId" = ${variantId}::uuid
        AND ("factsVersion" < ${version}
             OR ("factsVersion" = ${version} AND ("factsAt" IS NULL OR "factsAt" < ${at})))`;
    return n > 0;
  }

  /** A price may arrive before the facts: the row is created inactive until facts land. */
  async upsertPrice(
    tx: Tx,
    variantId: string,
    sellingPrice: string,
    sequence: number,
  ): Promise<boolean> {
    const n = await tx.$executeRaw`
      INSERT INTO "order_variant_projections" ("variantId", "sellingPrice", "priceVersion", "updatedAt")
      VALUES (${variantId}::uuid, ${sellingPrice}::numeric, ${sequence}, now())
      ON CONFLICT ("variantId") DO UPDATE SET
        "sellingPrice" = EXCLUDED."sellingPrice", "priceVersion" = EXCLUDED."priceVersion", "updatedAt" = now()
      WHERE "order_variant_projections"."priceVersion" < EXCLUDED."priceVersion"`;
    return n > 0;
  }

  /** inventory-service availability; may arrive before the facts (row created inactive). */
  async upsertAvailability(
    tx: Tx,
    variantId: string,
    availableQty: number,
    sequence: number,
  ): Promise<boolean> {
    const n = await tx.$executeRaw`
      INSERT INTO "order_variant_projections" ("variantId", "availableQty", "stockVersion", "updatedAt")
      VALUES (${variantId}::uuid, ${availableQty}, ${sequence}, now())
      ON CONFLICT ("variantId") DO UPDATE SET
        "availableQty" = EXCLUDED."availableQty", "stockVersion" = EXCLUDED."stockVersion", "updatedAt" = now()
      WHERE "order_variant_projections"."stockVersion" < EXCLUDED."stockVersion"`;
    return n > 0;
  }

  async upsertFarm(
    tx: Tx,
    f: Omit<FarmFacts, 'sourceVersion'>,
    version: number,
    at: Date,
  ): Promise<boolean> {
    const n = await tx.$executeRaw`
      INSERT INTO "order_farm_projections"
        ("farmId", "ownerUserId", "farmCode", "name", "category", "productionTypes", "gstin",
         "stateCode", "territoryCode", "pinCode", "status", "sourceVersion", "sourceAt", "updatedAt")
      VALUES (${f.farmId}::uuid, ${f.ownerUserId}::uuid, ${f.farmCode}, ${f.name}, ${f.category},
         ${f.productionTypes}::text[], ${f.gstin}, ${f.stateCode}, ${f.territoryCode}, ${f.pinCode},
         ${f.status}, ${version}, ${at}, now())
      ON CONFLICT ("farmId") DO UPDATE SET
        "ownerUserId" = EXCLUDED."ownerUserId", "farmCode" = EXCLUDED."farmCode", "name" = EXCLUDED."name",
        "category" = EXCLUDED."category", "productionTypes" = EXCLUDED."productionTypes",
        "gstin" = EXCLUDED."gstin", "stateCode" = EXCLUDED."stateCode",
        "territoryCode" = EXCLUDED."territoryCode", "pinCode" = EXCLUDED."pinCode",
        "status" = EXCLUDED."status", "sourceVersion" = EXCLUDED."sourceVersion",
        "sourceAt" = EXCLUDED."sourceAt", "updatedAt" = now()
      WHERE "order_farm_projections"."sourceVersion" < EXCLUDED."sourceVersion"
         OR ("order_farm_projections"."sourceVersion" = EXCLUDED."sourceVersion"
             AND "order_farm_projections"."sourceAt" < EXCLUDED."sourceAt")`;
    return n > 0;
  }

  async variants(ids: readonly string[]): Promise<VariantFacts[]> {
    const rows = await withPrismaErrors(() =>
      this.db.orderVariantProjection.findMany({ where: { variantId: { in: [...ids] } } }),
    );
    return rows.map((r) => ({
      variantId: r.variantId,
      productId: r.productId,
      sku: r.sku,
      name: r.name,
      categoryId: r.categoryId,
      categoryPath: r.categoryPath,
      brandId: r.brandId,
      hsnCode: r.hsnCode,
      gstRate: r.gstRate === null ? null : r.gstRate.toFixed(2),
      sellingPrice: r.sellingPrice === null ? null : r.sellingPrice.toFixed(2),
      temperatureClass: r.temperatureClass,
      isActive: r.isActive,
      minOrderQty: r.minOrderQty,
      maxOrderQty: r.maxOrderQty,
      isPrescriptionRequired: r.isPrescriptionRequired,
      availableQty: r.availableQty,
      hasFacts: r.factsVersion >= 0n,
    }));
  }

  async farm(farmId: string): Promise<FarmFacts | null> {
    const r = await withPrismaErrors(() =>
      this.db.orderFarmProjection.findUnique({ where: { farmId } }),
    );
    return r === null
      ? null
      : {
          farmId: r.farmId,
          ownerUserId: r.ownerUserId,
          farmCode: r.farmCode,
          name: r.name,
          category: r.category,
          productionTypes: r.productionTypes,
          gstin: r.gstin,
          stateCode: r.stateCode,
          territoryCode: r.territoryCode,
          pinCode: r.pinCode,
          status: r.status,
          sourceVersion: Number(r.sourceVersion),
        };
  }
}
