import type { Paginated } from '@farmx/common/types';
import { type Tx, cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type {
  AdminListQuery,
  IngredientInput,
  MediaInput,
  ProductStatus,
  PublicSort,
  VariantInput,
} from './products.types.js';

// ── Selects ──

const LOOKUP_REF = { select: { id: true, code: true, label: true } } as const;

export const VARIANT_SELECT = {
  id: true,
  productId: true,
  sku: true,
  barcode: true,
  name: true,
  packSize: true,
  packUnit: LOOKUP_REF,
  unitsPerPack: true,
  mrp: true,
  minOrderQty: true,
  maxOrderQty: true,
  isB2cEligible: true,
  weightGrams: true,
  lengthMm: true,
  widthMm: true,
  heightMm: true,
  hsnCode: true,
  gstRate: true,
  isDefault: true,
  isActive: true,
  sortOrder: true,
  version: true,
  price: { select: { sellingPrice: true } },
  availability: { select: { availableQty: true, inStock: true, lowStock: true } },
} satisfies Prisma.ProductVariantSelect;

const LIVE = { deletedAt: null } as const;

const MEDIA_SELECT = {
  id: true,
  variantId: true,
  kind: true,
  docType: true,
  url: true,
  mediaId: true,
  title: true,
  sortOrder: true,
  isPrimary: true,
} satisfies Prisma.ProductMediaSelect;

export const DETAIL_SELECT = {
  id: true,
  name: true,
  slug: true,
  productCode: true,
  shortDescription: true,
  description: true,
  categoryId: true,
  brandId: true,
  brandName: true,
  genericName: true,
  dosageForm: LOOKUP_REF,
  routes: { select: { lookup: LOOKUP_REF } },
  species: { select: { lookup: { select: { id: true, code: true, label: true, meta: true } } } },
  productionStages: true,
  indications: true,
  dosageInstructions: true,
  contraindications: true,
  sideEffects: true,
  precautions: true,
  withdrawalMeatDays: true,
  withdrawalEggDays: true,
  manufacturerName: true,
  manufacturerAddress: true,
  marketerName: true,
  drugSchedule: true,
  registrationAuthority: true,
  registrationNo: true,
  drugLicenseNo: true,
  manufacturingLicenseNo: true,
  isPrescriptionRequired: true,
  isVetConsultRequired: true,
  isAntimicrobial: true,
  temperatureClass: true,
  storageMinTempC: true,
  storageMaxTempC: true,
  isFreezeSensitive: true,
  isLightSensitive: true,
  isHumiditySensitive: true,
  storageInstructions: true,
  shelfLifeMonths: true,
  hazardClass: true,
  unNumber: true,
  hsnCode: true,
  gstRate: true,
  countryOfOrigin: true,
  tags: true,
  seoTitle: true,
  seoDescription: true,
  attributes: true,
  isFeatured: true,
  isActive: true,
  status: true,
  submittedByUserId: true,
  submittedAt: true,
  publishedByUserId: true,
  publishedAt: true,
  minPrice: true,
  maxPrice: true,
  maxDiscountPercent: true,
  ratingAvg: true,
  ratingCount: true,
  version: true,
  createdByUserId: true,
  updatedByUserId: true,
  createdAt: true,
  updatedAt: true,
  ingredients: {
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true,
      name: true,
      strength: true,
      unit: LOOKUP_REF,
      perQuantity: true,
      perUnit: LOOKUP_REF,
    },
  },
  variants: { where: LIVE, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: VARIANT_SELECT },
  media: { where: LIVE, orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }], select: MEDIA_SELECT },
} satisfies Prisma.ProductSelect;

export type ProductRecord = Prisma.ProductGetPayload<{ select: typeof DETAIL_SELECT }>;
export type VariantRecord = Prisma.ProductVariantGetPayload<{ select: typeof VARIANT_SELECT }>;

const CARD_SELECT = {
  id: true,
  name: true,
  slug: true,
  productCode: true,
  shortDescription: true,
  categoryId: true,
  brandId: true,
  brandName: true,
  genericName: true,
  dosageForm: LOOKUP_REF,
  isPrescriptionRequired: true,
  temperatureClass: true,
  isFeatured: true,
  minPrice: true,
  maxPrice: true,
  ratingAvg: true,
  ratingCount: true,
  media: {
    where: { ...LIVE, kind: 'IMAGE', variantId: null },
    orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
    take: 1,
    select: { url: true },
  },
  variants: {
    where: { ...LIVE, isActive: true },
    orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }],
    select: VARIANT_SELECT,
  },
} satisfies Prisma.ProductSelect;

export type CardRecord = Prisma.ProductGetPayload<{ select: typeof CARD_SELECT }>;

const ADMIN_ROW_SELECT = {
  id: true,
  name: true,
  slug: true,
  productCode: true,
  categoryId: true,
  brandId: true,
  brandName: true,
  status: true,
  drugSchedule: true,
  temperatureClass: true,
  isActive: true,
  isFeatured: true,
  updatedAt: true,
  version: true,
  _count: { select: { variants: { where: LIVE } } },
  variants: { where: { ...LIVE, isDefault: true }, take: 1, select: { sku: true } },
} satisfies Prisma.ProductSelect;

export type AdminRowRecord = Prisma.ProductGetPayload<{ select: typeof ADMIN_ROW_SELECT }>;

/** Scalar product columns written by create/update (relations handled separately). */
export type ProductData = Omit<
  Prisma.ProductUncheckedCreateInput,
  | 'id'
  | 'routes'
  | 'species'
  | 'ingredients'
  | 'variants'
  | 'media'
  | 'createdByUserId'
  | 'updatedByUserId'
  | 'version'
>;

export interface StorefrontFilter {
  /** Search candidates (already ranked); undefined = no text search. */
  ids?: string[];
  /** Category subtree ∩ visible categories; undefined = any visible. */
  categoryIds?: string[];
  brandIds?: string[];
  dosageForm?: string;
  species?: string[];
  route?: string[];
  isPrescriptionRequired?: boolean;
  temperatureClass?: string;
  inStock?: boolean;
  minPrice?: number;
  maxPrice?: number;
  /** Published average ≥ this ("4★ & up"). */
  minRating?: number;
  isFeatured?: boolean;
  attrs: { key: string; values: (string | number | boolean)[]; multi: boolean }[];
}

type Client = Cradle['db'] | Tx;

const refLockKey = (type: 'CATEGORY' | 'BRAND', id: string) => `product-ref:${type}:${id}`;

/** Only place that queries the product-service product tables. */
export class ProductsRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  // ── Locks & references (safe-delete protocol, plan §E) ──

  /** Row lock on a live product: serialises every variant/default change on it. */
  async lockProduct(tx: Tx, id: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "products" WHERE "id" = ${id}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
    return rows.length === 1;
  }

  /** Shared lock on a category/brand reference: many product writes may assign it concurrently. */
  async lockReferenceShared(tx: Tx, type: 'CATEGORY' | 'BRAND', id: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${refLockKey(type, id)}))`;
  }

  /** Exclusive lock: waits for in-flight assigning transactions, blocks new ones. */
  async lockReferenceExclusive(tx: Tx, type: 'CATEGORY' | 'BRAND', id: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${refLockKey(type, id)}))`;
  }

  async isBlocked(tx: Tx, type: 'CATEGORY' | 'BRAND', id: string): Promise<boolean> {
    const row = await tx.productReferenceBlock.findUnique({
      where: { refType_refId: { refType: type, refId: id } },
      select: { id: true },
    });
    return row !== null;
  }

  countUsing(tx: Tx, type: 'CATEGORY' | 'BRAND', id: string): Promise<number> {
    return tx.product.count({
      where: { ...LIVE, ...(type === 'CATEGORY' ? { categoryId: id } : { brandId: id }) },
    });
  }

  async block(tx: Tx, type: 'CATEGORY' | 'BRAND', id: string): Promise<void> {
    await tx.productReferenceBlock.upsert({
      where: { refType_refId: { refType: type, refId: id } },
      create: { refType: type, refId: id },
      update: {},
    });
  }

  async unblock(type: 'CATEGORY' | 'BRAND', id: string): Promise<void> {
    await withPrismaErrors(() =>
      this.db.productReferenceBlock.deleteMany({ where: { refType: type, refId: id } }),
    );
  }

  // ── Reads ──

  findDetail(id: string, client: Client = this.db): Promise<ProductRecord | null> {
    return withPrismaErrors(() =>
      client.product.findFirst({ where: { id, ...LIVE }, select: DETAIL_SELECT }),
    );
  }

  findDetailBy(where: { id: string } | { slug: string }): Promise<ProductRecord | null> {
    return withPrismaErrors(() =>
      this.db.product.findFirst({ where: { ...where, ...LIVE }, select: DETAIL_SELECT }),
    );
  }

  async slugsStartingWith(tx: Tx, base: string): Promise<Set<string>> {
    const rows = await tx.product.findMany({
      where: { ...LIVE, slug: { startsWith: base } },
      select: { slug: true },
    });
    return new Set(rows.map((r) => r.slug));
  }

  async slugTaken(tx: Tx, slug: string, excludeId?: string): Promise<boolean> {
    const row = await tx.product.findFirst({
      where: { ...LIVE, slug, ...(excludeId === undefined ? {} : { id: { not: excludeId } }) },
      select: { id: true },
    });
    return row !== null;
  }

  async nextProductSeq(tx: Tx): Promise<bigint> {
    const rows = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('product_code_seq') AS n`;
    return rows[0]?.n ?? 1n;
  }

  /** SKUs / barcodes already used by another live variant. */
  async variantKeyConflicts(
    tx: Tx,
    skus: readonly string[],
    barcodes: readonly string[],
    excludeVariantId?: string,
  ): Promise<{ skus: string[]; barcodes: string[] }> {
    if (skus.length === 0 && barcodes.length === 0) return { skus: [], barcodes: [] };
    const rows = await tx.productVariant.findMany({
      where: {
        ...LIVE,
        ...(excludeVariantId === undefined ? {} : { id: { not: excludeVariantId } }),
        OR: [
          ...(skus.length > 0 ? [{ sku: { in: [...skus] } }] : []),
          ...(barcodes.length > 0 ? [{ barcode: { in: [...barcodes] } }] : []),
        ],
      },
      select: { sku: true, barcode: true },
    });
    return {
      skus: rows.map((r) => r.sku).filter((s) => skus.includes(s)),
      barcodes: rows.flatMap((r) =>
        r.barcode !== null && barcodes.includes(r.barcode) ? [r.barcode] : [],
      ),
    };
  }

  liveVariants(tx: Tx, productId: string) {
    return tx.productVariant.findMany({
      where: { productId, ...LIVE },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: VARIANT_SELECT,
    });
  }

  // ── Product writes ──

  async create(
    tx: Tx,
    data: ProductData & { id: string },
    relations: {
      routeIds: string[];
      speciesIds: string[];
      ingredients: IngredientInput[];
      variants: (VariantInput & { isDefault: boolean })[];
    },
    actorUserId: string,
  ): Promise<void> {
    await tx.product.create({
      data: {
        ...data,
        createdByUserId: actorUserId,
        updatedByUserId: actorUserId,
        routes: { create: relations.routeIds.map((lookupId) => ({ lookupId })) },
        species: { create: relations.speciesIds.map((lookupId) => ({ lookupId })) },
        ingredients: { create: relations.ingredients.map((ing, i) => this.ingredientData(ing, i)) },
        variants: {
          create: relations.variants.map((v, i) => this.variantData(v, i, actorUserId)),
        },
      },
      select: { id: true },
    });
  }

  async update(
    tx: Tx,
    id: string,
    data: Partial<ProductData>,
    relations: { routeIds?: string[]; speciesIds?: string[]; ingredients?: IngredientInput[] },
    actorUserId: string,
  ): Promise<void> {
    if (relations.routeIds !== undefined) {
      await tx.productRoute.deleteMany({ where: { productId: id } });
      await tx.productRoute.createMany({
        data: relations.routeIds.map((lookupId) => ({ productId: id, lookupId })),
      });
    }
    if (relations.speciesIds !== undefined) {
      await tx.productSpecies.deleteMany({ where: { productId: id } });
      await tx.productSpecies.createMany({
        data: relations.speciesIds.map((lookupId) => ({ productId: id, lookupId })),
      });
    }
    if (relations.ingredients !== undefined) {
      await tx.productIngredient.deleteMany({ where: { productId: id } });
      await tx.productIngredient.createMany({
        data: relations.ingredients.map((ing, i) => ({
          productId: id,
          ...this.ingredientData(ing, i),
        })),
      });
    }
    await tx.product.update({
      where: { id },
      data: { ...data, updatedByUserId: actorUserId, version: { increment: 1 } },
      select: { id: true },
    });
  }

  async touch(tx: Tx, id: string, actorUserId: string, data: Partial<ProductData> = {}) {
    await tx.product.update({
      where: { id },
      data: { ...data, updatedByUserId: actorUserId, version: { increment: 1 } },
      select: { id: true },
    });
  }

  async softDelete(tx: Tx, id: string, actorUserId: string): Promise<void> {
    const now = new Date();
    await tx.productVariant.updateMany({
      where: { productId: id, ...LIVE },
      data: { deletedAt: now, isDefault: false, updatedByUserId: actorUserId },
    });
    await tx.productMedia.updateMany({
      where: { productId: id, ...LIVE },
      data: { deletedAt: now },
    });
    await tx.product.update({
      where: { id },
      data: { deletedAt: now, updatedByUserId: actorUserId, version: { increment: 1 } },
    });
  }

  // ── Variant writes ──

  async createVariant(tx: Tx, productId: string, input: VariantInput, actorUserId: string) {
    return tx.productVariant.create({
      data: { productId, ...this.variantData(input, input.sortOrder ?? 0, actorUserId) },
      select: VARIANT_SELECT,
    });
  }

  async updateVariant(
    tx: Tx,
    id: string,
    data: Prisma.ProductVariantUncheckedUpdateInput,
    actorUserId: string,
  ) {
    return tx.productVariant.update({
      where: { id },
      data: { ...data, updatedByUserId: actorUserId, version: { increment: 1 } },
      select: VARIANT_SELECT,
    });
  }

  async softDeleteVariant(tx: Tx, id: string, actorUserId: string): Promise<void> {
    await tx.productVariant.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        isDefault: false,
        updatedByUserId: actorUserId,
        version: { increment: 1 },
      },
    });
    await tx.productMedia.updateMany({
      where: { variantId: id, ...LIVE },
      data: { deletedAt: new Date() },
    });
  }

  // ── Media writes ──

  async unsetPrimary(tx: Tx, productId: string, exceptId?: string): Promise<void> {
    await tx.productMedia.updateMany({
      where: {
        productId,
        kind: 'IMAGE',
        isPrimary: true,
        ...LIVE,
        ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
      },
      data: { isPrimary: false },
    });
  }

  createMedia(tx: Tx, productId: string, input: Omit<MediaInput, 'reason'>, actorUserId: string) {
    return tx.productMedia.create({
      data: {
        productId,
        variantId: input.variantId ?? null,
        kind: input.kind,
        docType: input.docType ?? null,
        url: input.url,
        mediaId: input.mediaId ?? null,
        title: input.title ?? null,
        sortOrder: input.sortOrder ?? 0,
        isPrimary: input.kind === 'IMAGE' && input.isPrimary === true,
        createdByUserId: actorUserId,
      },
      select: MEDIA_SELECT,
    });
  }

  findMedia(tx: Tx, productId: string, mediaId: string) {
    return tx.productMedia.findFirst({
      where: { id: mediaId, productId, ...LIVE },
      select: MEDIA_SELECT,
    });
  }

  updateMedia(tx: Tx, id: string, data: Prisma.ProductMediaUncheckedUpdateInput) {
    return tx.productMedia.update({ where: { id }, data, select: MEDIA_SELECT });
  }

  async softDeleteMedia(tx: Tx, id: string): Promise<void> {
    await tx.productMedia.update({
      where: { id },
      data: { deletedAt: new Date(), isPrimary: false },
    });
  }

  // ── Admin list ──

  async adminList(
    query: AdminListQuery,
    categoryIds: string[] | undefined,
  ): Promise<Paginated<AdminRowRecord>> {
    const q = query.q?.trim();
    const where: Prisma.ProductWhereInput = {
      ...LIVE,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(categoryIds === undefined ? {} : { categoryId: { in: categoryIds } }),
      ...(query.brandId === undefined ? {} : { brandId: query.brandId }),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.isFeatured === undefined ? {} : { isFeatured: query.isFeatured }),
      ...(q === undefined || q === ''
        ? {}
        : {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { productCode: { contains: q.toUpperCase() } },
              { genericName: { contains: q, mode: 'insensitive' } },
              { variants: { some: { ...LIVE, sku: { contains: q.toUpperCase() } } } },
            ],
          }),
    };
    const rows = await withPrismaErrors(() =>
      this.db.product.findMany({
        where,
        select: ADMIN_ROW_SELECT,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        ...cursorArgs(query),
      }),
    );
    return toPage(rows, query.limit);
  }

  // ── Storefront ──

  /** Full-text + trigram candidates, best first (capped). */
  async searchCandidates(q: string, limit = 500): Promise<string[]> {
    const rows = await withPrismaErrors(
      () =>
        this.db.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "products"
        WHERE "deletedAt" IS NULL AND "status" = 'PUBLISHED' AND "isActive"
          AND ("searchVector" @@ plainto_tsquery('simple', ${q})
               OR "searchText" ILIKE ${`%${q.toLowerCase()}%`}
               OR similarity("searchText", ${q.toLowerCase()}) > 0.2)
        ORDER BY ts_rank("searchVector", plainto_tsquery('simple', ${q})) DESC,
                 similarity("searchText", ${q.toLowerCase()}) DESC, "id"
        LIMIT ${limit}`,
    );
    return rows.map((r) => r.id);
  }

  storefrontWhere(f: StorefrontFilter): Prisma.ProductWhereInput {
    const and: Prisma.ProductWhereInput[] = [];
    if (f.minPrice !== undefined) and.push({ maxPrice: { gte: f.minPrice } });
    if (f.maxPrice !== undefined) and.push({ minPrice: { lte: f.maxPrice } });
    if (f.minRating !== undefined) and.push({ ratingAvg: { gte: f.minRating } });
    for (const attr of f.attrs) {
      and.push({
        OR: attr.values.map((value) =>
          attr.multi
            ? { attributes: { path: [attr.key], array_contains: [value] } }
            : { attributes: { path: [attr.key], equals: value } },
        ),
      });
    }
    return {
      ...LIVE,
      status: 'PUBLISHED',
      isActive: true,
      ...(f.ids === undefined ? {} : { id: { in: f.ids } }),
      ...(f.categoryIds === undefined ? {} : { categoryId: { in: f.categoryIds } }),
      ...(f.brandIds === undefined ? {} : { brandId: { in: f.brandIds } }),
      ...(f.dosageForm === undefined ? {} : { dosageForm: { code: f.dosageForm } }),
      ...(f.species === undefined
        ? {}
        : { species: { some: { lookup: { code: { in: f.species } } } } }),
      ...(f.route === undefined ? {} : { routes: { some: { lookup: { code: { in: f.route } } } } }),
      ...(f.isPrescriptionRequired === undefined
        ? {}
        : { isPrescriptionRequired: f.isPrescriptionRequired }),
      ...(f.temperatureClass === undefined
        ? {}
        : { temperatureClass: f.temperatureClass as Prisma.EnumTemperatureClassFilter['equals'] }),
      ...(f.isFeatured === undefined ? {} : { isFeatured: f.isFeatured }),
      variants: {
        some: {
          ...LIVE,
          isActive: true,
          ...(f.inStock === true ? { availability: { inStock: true } } : {}),
        },
      },
      ...(and.length === 0 ? {} : { AND: and }),
    };
  }

  /** Ids matching `where`, in `sort` order (relevance order comes from the caller). */
  async storefrontIds(
    where: Prisma.ProductWhereInput,
    sort: PublicSort,
    max = 2_000,
  ): Promise<string[]> {
    const nullsLast = (dir: 'asc' | 'desc') => ({ sort: dir, nulls: 'last' as const });
    const orderBy: Prisma.ProductOrderByWithRelationInput[] =
      sort === 'name'
        ? [{ name: 'asc' }]
        : sort === 'price_asc'
          ? [{ minPrice: nullsLast('asc') }]
          : sort === 'price_desc'
            ? [{ maxPrice: nullsLast('desc') }]
            : sort === 'discount'
              ? [{ maxDiscountPercent: nullsLast('desc') }]
              : sort === 'newest'
                ? [{ publishedAt: nullsLast('desc') }]
                : sort === 'rating'
                  ? [{ ratingAvg: nullsLast('desc') }, { ratingCount: 'desc' as const }]
                  : [{ isFeatured: 'desc' }, { name: 'asc' }];
    const rows = await withPrismaErrors(() =>
      this.db.product.findMany({
        where,
        select: { id: true },
        orderBy: [...orderBy, { id: 'asc' }],
        take: max,
      }),
    );
    return rows.map((r) => r.id);
  }

  cards(ids: readonly string[]): Promise<CardRecord[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return withPrismaErrors(() =>
      this.db.product.findMany({ where: { id: { in: [...ids] } }, select: CARD_SELECT }),
    );
  }

  /** Cards + visibility flags for any ids (internal: wishlist hydration); deleted rows included. */
  internalCards(ids: readonly string[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return withPrismaErrors(() =>
      this.db.product.findMany({
        where: { id: { in: [...ids] } },
        select: { ...CARD_SELECT, status: true, isActive: true, deletedAt: true },
      }),
    );
  }

  /** Brands and price range present among visible products (facets for the filter UI). */
  async facets(where: Prisma.ProductWhereInput) {
    const [brands, range] = await Promise.all([
      this.db.product.groupBy({ by: ['brandId', 'brandName'], where, _count: { _all: true } }),
      this.db.product.aggregate({ where, _min: { minPrice: true }, _max: { maxPrice: true } }),
    ]);
    return { brands, minPrice: range._min.minPrice, maxPrice: range._max.maxPrice };
  }

  /** Visible products sharing the same ingredient set (other brands first). */
  async alternatives(productId: string, names: readonly string[], limit = 10): Promise<string[]> {
    if (names.length === 0) return [];
    const lower = names.map((n) => n.toLowerCase());
    const rows = await withPrismaErrors(
      () =>
        this.db.$queryRaw<{ productId: string }[]>`
        SELECT i."productId" FROM "product_ingredients" i
        JOIN "products" p ON p."id" = i."productId"
        WHERE p."deletedAt" IS NULL AND p."status" = 'PUBLISHED' AND p."isActive"
          AND p."id" <> ${productId}::uuid
        GROUP BY i."productId"
        HAVING array_agg(DISTINCT lower(i."name") ORDER BY lower(i."name")) = ${[...new Set(lower)].sort()}::text[]
        LIMIT ${limit}`,
    );
    return rows.map((r) => r.productId);
  }

  // ── Projections & events ──

  variantExists(tx: Tx, variantId: string): Promise<{ productId: string } | null> {
    return tx.productVariant.findUnique({ where: { id: variantId }, select: { productId: true } });
  }

  /** Upsert guarded by the producer sequence: an older event never overwrites a newer one. */
  async upsertPrice(
    tx: Tx,
    variantId: string,
    data: { sellingPrice: string; currency: string; effectiveFrom: Date; sourceEventId: string },
    sequence: number,
  ): Promise<boolean> {
    const changed = await tx.$executeRaw`
      INSERT INTO "variant_price_projections"
        ("variantId", "sellingPrice", "currency", "effectiveFrom", "sourceEventId", "sourceVersion", "updatedAt")
      VALUES (${variantId}::uuid, ${data.sellingPrice}::numeric, ${data.currency}, ${data.effectiveFrom},
              ${data.sourceEventId}::uuid, ${sequence}, now())
      ON CONFLICT ("variantId") DO UPDATE SET
        "sellingPrice" = EXCLUDED."sellingPrice", "currency" = EXCLUDED."currency",
        "effectiveFrom" = EXCLUDED."effectiveFrom", "sourceEventId" = EXCLUDED."sourceEventId",
        "sourceVersion" = EXCLUDED."sourceVersion", "updatedAt" = now()
      WHERE "variant_price_projections"."sourceVersion" < EXCLUDED."sourceVersion"`;
    return changed === 1;
  }

  async upsertAvailability(
    tx: Tx,
    variantId: string,
    data: { availableQty: number; inStock: boolean; lowStock: boolean },
    sequence: number,
  ): Promise<boolean> {
    const changed = await tx.$executeRaw`
      INSERT INTO "variant_availability"
        ("variantId", "availableQty", "inStock", "lowStock", "sourceVersion", "updatedAt")
      VALUES (${variantId}::uuid, ${data.availableQty}, ${data.inStock}, ${data.lowStock}, ${sequence}, now())
      ON CONFLICT ("variantId") DO UPDATE SET
        "availableQty" = EXCLUDED."availableQty", "inStock" = EXCLUDED."inStock",
        "lowStock" = EXCLUDED."lowStock", "sourceVersion" = EXCLUDED."sourceVersion", "updatedAt" = now()
      WHERE "variant_availability"."sourceVersion" < EXCLUDED."sourceVersion"`;
    return changed === 1;
  }

  /** Active variants' MRP + projected selling price (for the product price summary). */
  pricedVariants(tx: Tx, productId: string) {
    return tx.productVariant.findMany({
      where: { productId, ...LIVE, isActive: true },
      select: { mrp: true, price: { select: { sellingPrice: true } } },
    });
  }

  async setPriceSummary(
    tx: Tx,
    productId: string,
    s: { minPrice: string | null; maxPrice: string | null; maxDiscountPercent: string | null },
  ): Promise<void> {
    await tx.product.update({ where: { id: productId }, data: s, select: { id: true } });
  }

  /** Denormalised published rating (reviews feature, same transaction as the review change). */
  async setRating(
    tx: Tx,
    productId: string,
    rating: { ratingAvg: string | null; ratingCount: number },
  ): Promise<void> {
    await tx.product.update({ where: { id: productId }, data: rating, select: { id: true } });
  }

  /** Minimal live product facts for the reviews feature, by id or slug (null = missing or deleted). */
  reviewTarget(ref: { id: string } | { slug: string }) {
    return withPrismaErrors(() =>
      this.db.product.findFirst({
        where: { ...ref, ...LIVE },
        select: { id: true, name: true, slug: true, status: true, isActive: true },
      }),
    );
  }

  /** id → name/slug for admin review lists (deleted products included). */
  productNames(ids: readonly string[]) {
    return withPrismaErrors(() =>
      this.db.product.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, name: true, slug: true },
      }),
    );
  }

  productsOfBrand(tx: Tx, brandId: string) {
    return tx.product.findMany({
      where: { brandId, ...LIVE },
      select: {
        id: true,
        slug: true,
        name: true,
        genericName: true,
        productCode: true,
        manufacturerName: true,
        tags: true,
        ingredients: { select: { name: true } },
      },
    });
  }

  async setSearchFields(
    tx: Tx,
    id: string,
    data: { brandName?: string; searchText: string },
  ): Promise<void> {
    await tx.product.update({ where: { id }, data, select: { id: true } });
  }

  /** Variant facts for inventory / order / logistics (internal API). */
  variantFacts(ids: readonly string[]) {
    return withPrismaErrors(() =>
      this.db.productVariant.findMany({
        where: { id: { in: [...ids] } },
        select: {
          id: true,
          productId: true,
          sku: true,
          barcode: true,
          name: true,
          packSize: true,
          packUnit: { select: { code: true } },
          isActive: true,
          deletedAt: true,
          version: true,
          hsnCode: true,
          gstRate: true,
          minOrderQty: true,
          maxOrderQty: true,
          product: {
            select: {
              categoryId: true,
              brandId: true,
              name: true,
              manufacturerName: true,
              isPrescriptionRequired: true,
              temperatureClass: true,
              shelfLifeMonths: true,
            },
          },
        },
      }),
    );
  }

  // ── Mapping helpers ──

  private ingredientData(ing: IngredientInput, index: number) {
    return {
      name: ing.name,
      strength: ing.strength,
      unitId: ing.unitId,
      perQuantity: ing.perQuantity ?? null,
      perUnitId: ing.perUnitId ?? null,
      sortOrder: index,
    };
  }

  private variantData(v: VariantInput, index: number, actorUserId: string) {
    return {
      sku: v.sku,
      barcode: v.barcode ?? null,
      name: v.name,
      packSize: v.packSize,
      packUnitId: v.packUnitId,
      unitsPerPack: v.unitsPerPack ?? 1,
      mrp: v.mrp,
      minOrderQty: v.minOrderQty ?? 1,
      maxOrderQty: v.maxOrderQty ?? null,
      isB2cEligible: v.isB2cEligible ?? false,
      weightGrams: v.weightGrams ?? null,
      lengthMm: v.lengthMm ?? null,
      widthMm: v.widthMm ?? null,
      heightMm: v.heightMm ?? null,
      hsnCode: v.hsnCode ?? null,
      gstRate: v.gstRate ?? null,
      isDefault: v.isDefault === true,
      isActive: v.isActive ?? true,
      sortOrder: v.sortOrder ?? index * 10,
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
    };
  }

  /** For status transitions. */
  async setStatus(
    tx: Tx,
    id: string,
    status: ProductStatus,
    extra: Partial<ProductData>,
    actorUserId: string,
  ): Promise<void> {
    await this.touch(tx, id, actorUserId, { ...extra, status });
  }
}
