import { ConflictError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import { type Tx, cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import { farmCodePreview, normalizeName } from './farm.rules.js';
import type {
  ActorType,
  AdminFarmListItem,
  AdminFarmListQuery,
  AgeBand,
  CapacityInput,
  DuplicateCandidate,
  FarmCategory,
  FarmListQuery,
  FarmStatus,
  FarmSummary,
  FarmView,
  InvoiceNameSource,
  KycStatus,
  ProductionType,
} from './farms.types.js';

/** One SELECT for a full view: farm + capacities + owner (same feature → relations allowed). */
const FARM_SELECT = {
  id: true,
  farmCode: true,
  ownerId: true,
  category: true,
  productionTypes: true,
  name: true,
  gstin: true,
  invoiceNameSource: true,
  invoiceName: true,
  gstBusinessName: true,
  gstTradeName: true,
  gstVerifiedAt: true,
  latitude: true,
  longitude: true,
  gpsAccuracyM: true,
  locationCapturedAt: true,
  addressLine: true,
  village: true,
  pinCode: true,
  territoryCode: true,
  districtName: true,
  mandalName: true,
  primaryNodeId: true,
  backupNodeId: true,
  totalBirdCapacity: true,
  status: true,
  statusReason: true,
  registrationStep: true,
  kycDeferredAt: true,
  submittedAt: true,
  activatedAt: true,
  mergedIntoFarmId: true,
  channel: true,
  createdByUserId: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  capacities: {
    select: { productionType: true, metric: true, value: true, period: true, rank: true },
    orderBy: [{ rank: 'asc' }, { metric: 'asc' }],
  },
  owner: {
    select: {
      id: true,
      userId: true,
      fullName: true,
      phone: true,
      ageBand: true,
      panMasked: true,
      aadhaarLast4: true,
      kycStatus: true,
      personalizedOffers: true,
    },
  },
} satisfies Prisma.FarmSelect;

type FarmRow = Prisma.FarmGetPayload<{ select: typeof FARM_SELECT }>;

const SUMMARY_SELECT = {
  id: true,
  farmCode: true,
  name: true,
  category: true,
  productionTypes: true,
  status: true,
  registrationStep: true,
  village: true,
  pinCode: true,
  totalBirdCapacity: true,
  createdAt: true,
} satisfies Prisma.FarmSelect;

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export const toFarmView = (row: FarmRow): FarmView => ({
  id: row.id,
  farmCode: row.farmCode,
  farmCodePreview: row.farmCode ?? farmCodePreview(row.territoryCode, row.productionTypes[0]),
  category: row.category,
  productionTypes: row.productionTypes,
  name: row.name,
  status: row.status,
  statusReason: row.statusReason,
  registrationStep: row.registrationStep,
  owner: row.owner,
  capacities: row.capacities.map((c) => ({ ...c, value: c.value.toNumber() })),
  totalBirdCapacity: row.totalBirdCapacity,
  location:
    // Present once a pin code is set; GPS is optional (backyard quick sign-up has none).
    row.pinCode === null
      ? null
      : {
          latitude: row.latitude?.toNumber() ?? null,
          longitude: row.longitude?.toNumber() ?? null,
          gpsAccuracyM: row.gpsAccuracyM,
          capturedAt: iso(row.locationCapturedAt),
          addressLine: row.addressLine,
          village: row.village,
          pinCode: row.pinCode,
          territoryCode: row.territoryCode,
          districtName: row.districtName,
          mandalName: row.mandalName,
          primaryNodeId: row.primaryNodeId,
          backupNodeId: row.backupNodeId,
        },
  billing: {
    gstin: row.gstin,
    invoiceNameSource: row.invoiceNameSource,
    invoiceName: row.invoiceName,
    gstVerified: row.gstin !== null,
    businessName: row.gstBusinessName,
    tradeName: row.gstTradeName,
    gstVerifiedAt: iso(row.gstVerifiedAt),
  },
  kycDeferred: row.kycDeferredAt !== null,
  channel: row.channel,
  createdByUserId: row.createdByUserId,
  mergedIntoFarmId: row.mergedIntoFarmId,
  submittedAt: iso(row.submittedAt),
  activatedAt: iso(row.activatedAt),
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toSummary = (row: Prisma.FarmGetPayload<{ select: typeof SUMMARY_SELECT }>): FarmSummary => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
});

export interface FarmPatch {
  name?: string;
  nameNormalized?: string;
  productionTypes?: ProductionType[];
  totalBirdCapacity?: number | null;
  registrationStep?: number;
  latitude?: number;
  longitude?: number;
  gpsAccuracyM?: number;
  locationCapturedAt?: Date;
  addressLine?: string | null;
  village?: string;
  pinCode?: string;
  territoryId?: string;
  territoryCode?: string;
  districtName?: string;
  mandalName?: string | null;
  primaryNodeId?: string | null;
  backupNodeId?: string | null;
  gstin?: string | null;
  gstVerificationId?: string | null;
  invoiceNameSource?: InvoiceNameSource;
  invoiceName?: string | null;
  gstBusinessName?: string | null;
  gstTradeName?: string | null;
  gstVerifiedAt?: Date | null;
  kycDeferredAt?: Date | null;
  status?: FarmStatus;
  statusReason?: string | null;
  statusChangedAt?: Date;
  submittedAt?: Date;
  activatedAt?: Date;
  farmCode?: string;
  mergedIntoFarmId?: string;
}

export interface OwnerPatch {
  fullName?: string;
  ageBand?: AgeBand | null;
  personalizedOffers?: boolean;
  panCipher?: Uint8Array<ArrayBuffer>;
  panKeyId?: number;
  panHash?: string;
  panMasked?: string;
  panVerifiedAt?: Date;
  aadhaarLast4?: string;
  aadhaarRefId?: string;
  aadhaarNameMatch?: boolean;
  aadhaarVerifiedAt?: Date;
  kycStatus?: KycStatus;
  kycStatusChangedAt?: Date;
}

/** Only place that queries farms, farm_owners, farm_capacities, farm_status_events, sequences. */
export class FarmsRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  // ── Owners ──

  findOwnerByUserId(userId: string) {
    return withPrismaErrors(() =>
      this.db.farmOwner.findUnique({
        where: { userId },
        select: { id: true, panHash: true, deletedAt: true },
      }),
    );
  }

  /** Idempotent: one owner row per customer user. */
  upsertOwner(tx: Tx, userId: string, data: { fullName?: string; phone?: string | null }) {
    return tx.farmOwner.upsert({
      where: { userId },
      create: { userId, fullName: data.fullName ?? '', phone: data.phone ?? null },
      update: data.fullName === undefined ? {} : { fullName: data.fullName },
      select: { id: true },
    });
  }

  async updateOwner(tx: Tx, ownerId: string, patch: OwnerPatch): Promise<void> {
    await tx.farmOwner.update({ where: { id: ownerId }, data: patch });
  }

  findOwnerPan(ownerId: string) {
    return withPrismaErrors(() =>
      this.db.farmOwner.findUnique({
        where: { id: ownerId },
        select: { panCipher: true, panHash: true },
      }),
    );
  }

  async insertConsent(
    tx: Tx,
    ownerId: string,
    purpose: 'PERSONALIZED_OFFERS' | 'AADHAAR_EKYC',
    granted: boolean,
    ip: string | null,
  ): Promise<void> {
    await tx.farmOwnerConsent.create({
      data: { ownerId, purpose, granted, noticeVersion: '2026-11', ip },
    });
  }

  // ── Farms: reads ──

  async findView(id: string, tx?: Tx): Promise<FarmView | null> {
    const client = tx ?? this.db;
    const row = await withPrismaErrors(() =>
      client.farm.findFirst({ where: { id, deletedAt: null }, select: FARM_SELECT }),
    );
    return row === null ? null : toFarmView(row);
  }

  async findIdByCode(farmCode: string): Promise<string | null> {
    const row = await withPrismaErrors(() =>
      this.db.farm.findUnique({ where: { farmCode }, select: { id: true } }),
    );
    return row?.id ?? null;
  }

  async findViews(ids: readonly string[]): Promise<FarmView[]> {
    const rows = await withPrismaErrors(() =>
      this.db.farm.findMany({
        where: { id: { in: [...ids] }, deletedAt: null },
        select: FARM_SELECT,
      }),
    );
    return rows.map(toFarmView);
  }

  countOpenDrafts(ownerId: string): Promise<number> {
    return withPrismaErrors(() =>
      this.db.farm.count({ where: { ownerId, status: 'DRAFT', deletedAt: null } }),
    );
  }

  /** Farms the user owns; index (ownerId, status) + id cursor. */
  async listForUser(userId: string, query: FarmListQuery): Promise<Paginated<FarmSummary>> {
    const rows = await withPrismaErrors(() =>
      this.db.farm.findMany({
        where: {
          owner: { userId },
          deletedAt: null,
          ...(query.status === undefined ? {} : { status: query.status }),
        },
        orderBy: { id: 'desc' },
        select: SUMMARY_SELECT,
        ...cursorArgs(query),
      }),
    );
    const page = toPage(rows, query.limit);
    return { ...page, items: page.items.map(toSummary) };
  }

  /**
   * Admin search. `q`: Farm ID prefix (FX-…, trigram/unique index), exact GSTIN (15 chars),
   * phone (+91…), otherwise partial name (trigram GIN index on nameNormalized).
   */
  async adminList(query: AdminFarmListQuery): Promise<Paginated<AdminFarmListItem>> {
    const q = query.q?.trim();
    let search: Prisma.FarmWhereInput = {};
    if (q !== undefined && q !== '') {
      if (/^FX-/i.test(q)) search = { farmCode: { startsWith: q.toUpperCase() } };
      else if (/^[0-9]{2}[A-Z0-9]{13}$/i.test(q)) search = { gstin: q.toUpperCase() };
      else if (/^\+?[0-9]{10,13}$/.test(q))
        search = { owner: { phone: q.startsWith('+') ? q : `+91${q.slice(-10)}` } };
      else search = { nameNormalized: { contains: q.toLowerCase() } };
    }
    const where: Prisma.FarmWhereInput = {
      deletedAt: null,
      ...search,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.category === undefined ? {} : { category: query.category }),
      ...(query.productionType === undefined
        ? {}
        : { productionTypes: { has: query.productionType } }),
      ...(query.territoryCode === undefined ? {} : { territoryCode: query.territoryCode }),
      ...(query.pinCode === undefined ? {} : { pinCode: query.pinCode }),
      ...(query.channel === undefined
        ? {}
        : { channel: query.channel as Prisma.FarmWhereInput['channel'] }),
      ...(query.kycStatus === undefined ? {} : { owner: { kycStatus: query.kycStatus } }),
      ...(query.createdFrom === undefined && query.createdTo === undefined
        ? {}
        : {
            createdAt: {
              ...(query.createdFrom === undefined ? {} : { gte: new Date(query.createdFrom) }),
              ...(query.createdTo === undefined ? {} : { lt: new Date(query.createdTo) }),
            },
          }),
    };
    const rows = await withPrismaErrors(() =>
      this.db.farm.findMany({
        where,
        orderBy: { id: 'desc' },
        select: {
          ...SUMMARY_SELECT,
          ownerId: true,
          territoryCode: true,
          submittedAt: true,
          owner: { select: { fullName: true, phone: true, kycStatus: true } },
        },
        ...cursorArgs(query),
      }),
    );
    const page = toPage(rows, query.limit);
    return {
      ...page,
      items: page.items.map(({ owner, submittedAt, ...row }) => ({
        ...toSummary(row),
        ownerId: row.ownerId,
        territoryCode: row.territoryCode,
        ownerName: owner.fullName,
        ownerPhone: owner.phone,
        kycStatus: owner.kycStatus,
        submittedAt: iso(submittedAt),
      })),
    };
  }

  async stats(): Promise<{ status: FarmStatus; category: FarmCategory; count: number }[]> {
    const rows = await withPrismaErrors(() =>
      this.db.farm.groupBy({
        by: ['status', 'category'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
    );
    return rows.map((r) => ({ status: r.status, category: r.category, count: r._count._all }));
  }

  listStatusEvents(farmId: string, limit = 20) {
    return withPrismaErrors(() =>
      this.db.farmStatusEvent.findMany({
        where: { farmId },
        orderBy: { id: 'desc' },
        take: limit,
        select: {
          fromStatus: true,
          toStatus: true,
          reason: true,
          actorType: true,
          createdAt: true,
        },
      }),
    );
  }

  // ── Farms: writes ──

  create(
    tx: Tx,
    data: {
      ownerId: string;
      category: FarmCategory;
      productionTypes: ProductionType[];
      name: string;
      channel: 'SELF' | 'FIELD_ASSISTED';
      createdByUserId: string;
    },
  ) {
    return tx.farm.create({
      data: { ...data, nameNormalized: normalizeName(data.name) },
      select: { id: true },
    });
  }

  /**
   * Optimistic concurrency: updates only if `version` still matches, and bumps it. A concurrent
   * edit makes the update hit 0 rows → 409 (client refetches and retries).
   */
  async update(tx: Tx, id: string, version: number, patch: FarmPatch): Promise<void> {
    const { count } = await tx.farm.updateMany({
      where: { id, version, deletedAt: null },
      data: { ...patch, version: { increment: 1 } },
    });
    if (count === 0) {
      throw new ConflictError('The farm was changed by someone else; reload and retry', {
        details: { reason: 'FARM_VERSION_CONFLICT' },
      });
    }
  }

  async softDelete(tx: Tx, id: string): Promise<void> {
    await tx.farm.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async replaceCapacities(
    tx: Tx,
    farmId: string,
    types: readonly ProductionType[],
    capacities: readonly CapacityInput[],
  ): Promise<void> {
    await tx.farmCapacity.deleteMany({ where: { farmId } });
    if (capacities.length === 0) return;
    await tx.farmCapacity.createMany({
      data: capacities.map((c) => ({ farmId, ...c, rank: types.indexOf(c.productionType) + 1 })),
    });
  }

  async insertStatusEvent(
    tx: Tx,
    event: {
      farmId: string;
      fromStatus: FarmStatus | null;
      toStatus: FarmStatus;
      reason?: string | null;
      actorType: ActorType;
      actorUserId: string | null;
      requestId: string | null;
    },
  ): Promise<void> {
    await tx.farmStatusEvent.create({ data: { ...event, reason: event.reason ?? null } });
  }

  /** Atomic per-(territory, type) serial: one row lock, no gaps under concurrency. */
  async nextSerial(tx: Tx, territoryCode: string, typeCode: string): Promise<number> {
    const rows = await tx.$queryRaw<{ lastValue: number }[]>`
      INSERT INTO "farm_id_sequences" ("territoryCode", "typeCode", "lastValue", "updatedAt")
      VALUES (${territoryCode}, ${typeCode}, 1, now())
      ON CONFLICT ("territoryCode", "typeCode")
      DO UPDATE SET "lastValue" = "farm_id_sequences"."lastValue" + 1, "updatedAt" = now()
      RETURNING "lastValue"`;
    const value = rows[0]?.lastValue;
    if (value === undefined) throw new Error('farm id sequence returned no row');
    return value;
  }

  /**
   * Duplicate candidates in ONE statement. Each UNION branch hits its own index (owner panHash,
   * farms gstin, GiST earthdistance), so the cost stays flat as the table grows.
   */
  async findDuplicateCandidates(
    tx: Tx,
    input: {
      farmId: string;
      ownerId: string;
      panHash: string | null;
      gstin: string | null;
      latitude: number | null;
      longitude: number | null;
      nameNormalized: string;
      radiusM: number;
    },
  ): Promise<DuplicateCandidate[]> {
    const {
      farmId,
      ownerId,
      panHash,
      gstin,
      latitude: lat,
      longitude: lng,
      nameNormalized,
      radiusM,
    } = input;
    const live = Prisma.sql`f."deletedAt" IS NULL AND f."status" IN ('UNDER_REVIEW','NEEDS_ATTENTION','ACTIVE','SUSPENDED')`;
    const geo =
      lat === null || lng === null
        ? Prisma.empty
        : Prisma.sql`UNION SELECT f."id" FROM "farms" f WHERE ${live} AND f."latitude" IS NOT NULL
            AND earth_box(ll_to_earth(${lat}::float8, ${lng}::float8), ${radiusM}::float8)
                @> ll_to_earth(f."latitude"::float8, f."longitude"::float8)`;
    const rows = await tx.$queryRaw<
      {
        farmId: string;
        ownerId: string;
        farmCode: string | null;
        name: string;
        sameOwner: boolean;
        distanceM: number | null;
        nameSimilarity: number;
        panMatch: boolean;
        gstinMatch: boolean;
      }[]
    >`
      WITH cand AS (
        SELECT f."id" FROM "farms" f JOIN "farm_owners" o ON o."id" = f."ownerId"
          WHERE ${panHash}::text IS NOT NULL AND o."panHash" = ${panHash} AND o."id" <> ${ownerId}::uuid AND ${live}
        UNION SELECT f."id" FROM "farms" f
          WHERE ${gstin}::text IS NOT NULL AND f."gstin" = ${gstin} AND f."ownerId" <> ${ownerId}::uuid AND ${live}
        ${geo}
      )
      SELECT f."id" AS "farmId", f."ownerId", f."farmCode", f."name",
             (f."ownerId" = ${ownerId}::uuid) AS "sameOwner",
             CASE WHEN f."latitude" IS NULL OR ${lat}::float8 IS NULL THEN NULL
                  ELSE round(earth_distance(ll_to_earth(${lat}::float8, ${lng}::float8),
                                            ll_to_earth(f."latitude"::float8, f."longitude"::float8)))::int END AS "distanceM",
             similarity(f."nameNormalized", ${nameNormalized})::float8 AS "nameSimilarity",
             (${panHash}::text IS NOT NULL AND o."panHash" = ${panHash}) AS "panMatch",
             (${gstin}::text IS NOT NULL AND f."gstin" = ${gstin}) AS "gstinMatch"
      FROM "farms" f JOIN "farm_owners" o ON o."id" = f."ownerId"
      WHERE f."id" IN (SELECT "id" FROM cand) AND f."id" <> ${farmId}::uuid
      LIMIT 10`;
    return rows;
  }
}
