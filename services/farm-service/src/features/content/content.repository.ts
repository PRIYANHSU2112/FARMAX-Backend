import { ConflictError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import { type Tx, cursorArgs, isUniqueViolation, toPage, withPrismaErrors } from '@farmx/database';
import { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type {
  AdminListQuery,
  Area,
  Asset,
  Block,
  CardRow,
  ContentFields,
  ContentKind,
  ContentRow,
  ContentStatus,
  CorrectionChanges,
  Cta,
  RevisionRow,
  ReviewerRow,
  Source,
  StatusEventRow,
  TopicRow,
} from './content.types.js';

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const num = (d: Prisma.Decimal | null): number | null => (d === null ? null : d.toNumber());

const ITEM_INCLUDE = {
  topic: { select: { id: true, code: true, name: true, clinical: true } },
  clinicalReviewer: {
    select: { id: true, displayName: true, qualification: true, registrationNo: true },
  },
} satisfies Prisma.ContentItemInclude;

type ItemWithRefs = Prisma.ContentItemGetPayload<{ include: typeof ITEM_INCLUDE }>;

const areaOf = (lat: Prisma.Decimal | null, lng: Prisma.Decimal | null): Area | null => {
  const a = num(lat);
  const b = num(lng);
  return a === null || b === null ? null : { lat: a, lng: b };
};

const assetOf = (r: {
  assetUrl: string | null;
  assetMediaId: string | null;
  assetKind: string | null;
  assetSizeBytes: number | null;
  durationSec: number | null;
  pageCount: number | null;
}): Asset | null =>
  r.assetUrl === null
    ? null
    : {
        url: r.assetUrl,
        mediaId: r.assetMediaId,
        kind: r.assetKind === 'pdf' ? 'pdf' : 'video',
        sizeBytes: r.assetSizeBytes,
        durationSec: r.durationSec,
        pageCount: r.pageCount,
      };

const toRow = (r: ItemWithRefs): ContentRow => ({
  id: r.id,
  slug: r.slug,
  kind: r.kind,
  topic: r.topic,
  title: r.title,
  summary: r.summary,
  heroImageUrl: r.heroImageUrl,
  heroMediaId: r.heroMediaId,
  blocks: r.blocks as unknown as Block[],
  sources: r.sources as unknown as Source[],
  ctas: r.ctas as unknown as Cta[],
  tags: r.tags,
  relatedIds: r.relatedIds,
  asset: assetOf(r),
  severity: r.severity,
  placeLabel: r.placeLabel,
  area: areaOf(r.areaLat, r.areaLng),
  productionTypes: r.productionTypes,
  territoryCodes: r.territoryCodes,
  readMinutes: r.readMinutes,
  reviewer: r.clinicalReviewer,
  clinicalSignedOffAt: iso(r.clinicalSignedOffAt),
  signedOffHash: r.signedOffHash,
  status: r.status,
  isFeatured: r.isFeatured,
  notify: r.notify,
  publishAt: iso(r.publishAt),
  publishedAt: iso(r.publishedAt),
  expiresAt: iso(r.expiresAt),
  expiredAt: iso(r.expiredAt),
  retractedAt: iso(r.retractedAt),
  retractNote: r.retractNote,
  notifiedAt: iso(r.notifiedAt),
  lastCorrectedAt: iso(r.lastCorrectedAt),
  correctionNote: r.correctionNote,
  contentVersion: r.contentVersion,
  version: r.version,
  viewCount: r.viewCount,
  helpfulYes: r.helpfulYes,
  helpfulNo: r.helpfulNo,
  saveCount: r.saveCount,
  shareCount: r.shareCount,
  trendingScore: r.trendingScore,
  createdByUserId: r.createdByUserId,
  updatedByUserId: r.updatedByUserId,
  submittedByUserId: r.submittedByUserId,
  submittedAt: iso(r.submittedAt),
  publishedByUserId: r.publishedByUserId,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/** Card columns only (no body / sources): the hot feed query. */
const CARD_SELECT = {
  id: true,
  slug: true,
  kind: true,
  title: true,
  summary: true,
  heroImageUrl: true,
  readMinutes: true,
  publishedAt: true,
  isFeatured: true,
  severity: true,
  placeLabel: true,
  areaLat: true,
  areaLng: true,
  assetKind: true,
  durationSec: true,
  pageCount: true,
  viewCount: true,
  topic: { select: { code: true, name: true } },
} satisfies Prisma.ContentItemSelect;

type CardRecord = Prisma.ContentItemGetPayload<{ select: typeof CARD_SELECT }>;

const toCard = (r: CardRecord): CardRow => ({
  id: r.id,
  slug: r.slug,
  kind: r.kind,
  topic: r.topic,
  title: r.title,
  summary: r.summary,
  heroImageUrl: r.heroImageUrl,
  readMinutes: r.readMinutes,
  publishedAt: iso(r.publishedAt),
  isFeatured: r.isFeatured,
  severity: r.severity,
  placeLabel: r.placeLabel,
  area: areaOf(r.areaLat, r.areaLng),
  assetKind: r.assetKind === 'pdf' ? 'pdf' : r.assetKind === 'video' ? 'video' : null,
  durationSec: r.durationSec,
  pageCount: r.pageCount,
  viewCount: r.viewCount,
});

const toTopic = (t: {
  id: string;
  code: string;
  name: string;
  clinical: boolean;
  sortOrder: number;
  isActive: boolean;
  version: number;
}): TopicRow => ({
  id: t.id,
  code: t.code,
  name: t.name,
  clinical: t.clinical,
  sortOrder: t.sortOrder,
  isActive: t.isActive,
  version: t.version,
});

const toReviewer = (r: Prisma.ContentReviewerGetPayload<object>): ReviewerRow => ({
  id: r.id,
  userId: r.userId,
  displayName: r.displayName,
  qualification: r.qualification,
  registrationNo: r.registrationNo,
  verifiedByUserId: r.verifiedByUserId,
  verifiedAt: r.verifiedAt.toISOString(),
  validUntil: r.validUntil.toISOString(),
  isActive: r.isActive,
  version: r.version,
});

const toRevision = (r: Prisma.ContentRevisionGetPayload<object>): RevisionRow => ({
  id: r.id,
  contentId: r.contentId,
  baseVersion: r.baseVersion,
  changes: r.changes as CorrectionChanges,
  changeNote: r.changeNote,
  status: r.status,
  requestedByUserId: r.requestedByUserId,
  requestedAt: r.requestedAt.toISOString(),
  signedOffById: r.signedOffById,
  signedOffAt: iso(r.signedOffAt),
  decidedByUserId: r.decidedByUserId,
  decidedAt: iso(r.decidedAt),
  rejectReason: r.rejectReason,
});

/** Reader segment: empty target lists match everyone. */
export interface Segment {
  territoryCode: string | null;
  productionTypes: string[];
}

const segmentWhere = (s: Segment): Prisma.ContentItemWhereInput => ({
  AND: [
    {
      OR: [
        { territoryCodes: { isEmpty: true } },
        ...(s.territoryCode === null ? [] : [{ territoryCodes: { has: s.territoryCode } }]),
      ],
    },
    {
      OR: [
        { productionTypes: { isEmpty: true } },
        ...(s.productionTypes.length === 0
          ? []
          : [
              {
                productionTypes: {
                  hasSome:
                    s.productionTypes as Prisma.EnumProductionTypeNullableListFilter['hasSome'],
                },
              },
            ]),
      ],
    },
  ],
});

/** Prisma column values of the reader-visible fields (create / update / correction). */
export type ItemData = Omit<
  Prisma.ContentItemUncheckedUpdateInput,
  'id' | 'version' | 'contentVersion'
>;

/** Prisma columns of the reader-visible fields + derived search text / reading time. */
export const columnsOf = (
  f: ContentFields,
  derived: { bodyText: string; readMinutes: number },
): ItemData => ({
  title: f.title,
  summary: f.summary,
  heroImageUrl: f.heroImageUrl,
  heroMediaId: f.heroMediaId,
  blocks: f.blocks,
  sources: f.sources as unknown as Prisma.InputJsonValue,
  ctas: f.ctas as unknown as Prisma.InputJsonValue,
  tags: f.tags,
  relatedIds: f.relatedIds,
  assetUrl: f.asset?.url ?? null,
  assetMediaId: f.asset?.mediaId ?? null,
  assetKind: f.asset?.kind ?? null,
  assetSizeBytes: f.asset?.sizeBytes ?? null,
  durationSec: f.asset?.durationSec ?? null,
  pageCount: f.asset?.pageCount ?? null,
  severity: f.severity,
  placeLabel: f.placeLabel,
  areaLat: f.area?.lat ?? null,
  areaLng: f.area?.lng ?? null,
  productionTypes: f.productionTypes as Prisma.ContentItemUncheckedUpdateInput['productionTypes'],
  territoryCodes: f.territoryCodes,
  bodyText: derived.bodyText,
  readMinutes: derived.readMinutes,
});

/** A new draft (fields + identity + workflow defaults). */
export interface NewItem {
  id: string;
  slug: string;
  kind: ContentKind;
  topicId: string;
  isFeatured: boolean;
  notify: boolean;
  expiresAt: Date | null;
  userId: string;
  columns: ItemData;
}

/** Engagement deltas flushed from Redis. */
export interface CounterDelta {
  id: string;
  views: number;
  yes: number;
  no: number;
  saves: number;
  shares: number;
}

/** Only place that queries the `content_*` tables. */
export class ContentRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  // ── Topics ──

  async listTopics(activeOnly: boolean): Promise<TopicRow[]> {
    const rows = await withPrismaErrors(() =>
      this.db.contentTopic.findMany({
        where: activeOnly ? { isActive: true } : {},
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      }),
    );
    return rows.map(toTopic);
  }

  async findTopic(id: string): Promise<TopicRow | null> {
    const row = await withPrismaErrors(() => this.db.contentTopic.findUnique({ where: { id } }));
    return row === null ? null : toTopic(row);
  }

  async createTopic(
    tx: Tx,
    data: Pick<TopicRow, 'code' | 'name' | 'clinical' | 'sortOrder'>,
    userId: string,
  ): Promise<TopicRow> {
    try {
      return toTopic(
        await tx.contentTopic.create({
          data: { ...data, createdByUserId: userId, updatedByUserId: userId },
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('A topic with this code exists');
      throw error;
    }
  }

  /** Optimistic update: false when the version moved. */
  async updateTopic(
    tx: Tx,
    id: string,
    version: number,
    data: Partial<Pick<TopicRow, 'name' | 'clinical' | 'sortOrder' | 'isActive'>>,
    userId: string,
  ): Promise<boolean> {
    const { count } = await tx.contentTopic.updateMany({
      where: { id, version },
      data: { ...data, updatedByUserId: userId, version: { increment: 1 } },
    });
    return count === 1;
  }

  // ── Reviewers ──

  async listReviewers(): Promise<ReviewerRow[]> {
    const rows = await withPrismaErrors(() =>
      this.db.contentReviewer.findMany({ orderBy: { displayName: 'asc' } }),
    );
    return rows.map(toReviewer);
  }

  async findReviewer(id: string, tx?: Tx): Promise<ReviewerRow | null> {
    const row = await withPrismaErrors(() =>
      (tx ?? this.db).contentReviewer.findUnique({ where: { id } }),
    );
    return row === null ? null : toReviewer(row);
  }

  async findReviewerByUser(userId: string, tx?: Tx): Promise<ReviewerRow | null> {
    const row = await withPrismaErrors(() =>
      (tx ?? this.db).contentReviewer.findUnique({ where: { userId } }),
    );
    return row === null ? null : toReviewer(row);
  }

  async createReviewer(
    tx: Tx,
    data: Omit<ReviewerRow, 'id' | 'verifiedAt' | 'validUntil' | 'isActive' | 'version'> & {
      validUntil: Date;
    },
  ): Promise<ReviewerRow> {
    try {
      return toReviewer(
        await tx.contentReviewer.create({ data: { ...data, verifiedAt: new Date() } }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('This user is already a reviewer');
      throw error;
    }
  }

  async updateReviewer(
    tx: Tx,
    id: string,
    version: number,
    data: Prisma.ContentReviewerUpdateManyMutationInput,
  ): Promise<boolean> {
    const { count } = await tx.contentReviewer.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    return count === 1;
  }

  // ── Items (admin) ──

  async create(tx: Tx, item: NewItem): Promise<ContentRow> {
    const data = {
      ...item.columns,
      id: item.id,
      slug: item.slug,
      kind: item.kind,
      topicId: item.topicId,
      isFeatured: item.isFeatured,
      notify: item.notify,
      expiresAt: item.expiresAt,
      createdByUserId: item.userId,
      updatedByUserId: item.userId,
    } as Prisma.ContentItemUncheckedCreateInput;
    try {
      return toRow(await tx.contentItem.create({ data, include: ITEM_INCLUDE }));
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('An item with this slug exists');
      throw error;
    }
  }

  async findById(id: string, tx?: Tx): Promise<ContentRow | null> {
    const row = await withPrismaErrors(() =>
      (tx ?? this.db).contentItem.findFirst({
        where: { id, deletedAt: null },
        include: ITEM_INCLUDE,
      }),
    );
    return row === null ? null : toRow(row);
  }

  /** Row lock for a state change (serialises approvals of the same item). */
  async lock(tx: Tx, id: string): Promise<void> {
    await tx.$executeRaw`SELECT 1 FROM "content_items" WHERE "id" = ${id}::uuid FOR UPDATE`;
  }

  /**
   * Optimistic update guarded by (version [, status]). Returns false when someone else changed it
   * first (→ 409). `bumpContent` increments the reader-visible contentVersion.
   */
  async update(
    tx: Tx,
    id: string,
    guard: { version: number; status?: ContentStatus | ContentStatus[] },
    data: ItemData,
    bumpContent = false,
  ): Promise<boolean> {
    const { count } = await tx.contentItem.updateMany({
      where: {
        id,
        deletedAt: null,
        version: guard.version,
        ...(guard.status === undefined
          ? {}
          : { status: Array.isArray(guard.status) ? { in: guard.status } : guard.status }),
      },
      data: {
        ...(data as Prisma.ContentItemUncheckedUpdateManyInput),
        version: { increment: 1 },
        ...(bumpContent ? { contentVersion: { increment: 1 } } : {}),
      },
    });
    return count === 1;
  }

  async softDelete(tx: Tx, id: string, version: number): Promise<boolean> {
    const { count } = await tx.contentItem.updateMany({
      where: { id, version, status: 'DRAFT', deletedAt: null },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
    return count === 1;
  }

  async adminList(query: AdminListQuery, topicId: string | null): Promise<Paginated<ContentRow>> {
    const rows = await withPrismaErrors(() =>
      this.db.contentItem.findMany({
        where: {
          deletedAt: null,
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.kind === undefined ? {} : { kind: query.kind }),
          ...(topicId === null ? {} : { topicId }),
          ...(query.q === undefined ? {} : { title: { contains: query.q, mode: 'insensitive' } }),
          ...(query.expiringWithin === undefined
            ? {}
            : {
                status: 'PUBLISHED',
                expiresAt: { lte: new Date(Date.now() + query.expiringWithin * 3_600_000) },
              }),
        },
        include: ITEM_INCLUDE,
        orderBy:
          query.expiringWithin === undefined
            ? { id: 'desc' }
            : [{ expiresAt: 'asc' }, { id: 'asc' }],
        ...cursorArgs(query),
      }),
    );
    const page = toPage(rows, query.limit);
    return { ...page, items: page.items.map(toRow) };
  }

  async insertStatusEvent(
    tx: Tx,
    contentId: string,
    from: ContentStatus | null,
    to: ContentStatus,
    actorUserId: string | null,
    reason: string | null,
  ): Promise<void> {
    await tx.contentStatusEvent.create({ data: { contentId, from, to, actorUserId, reason } });
  }

  async history(contentId: string): Promise<StatusEventRow[]> {
    const rows = await withPrismaErrors(() =>
      this.db.contentStatusEvent.findMany({
        where: { contentId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
    return rows.map((r) => ({
      from: r.from,
      to: r.to,
      actorUserId: r.actorUserId,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // ── Revisions (corrections) ──

  async createRevision(
    tx: Tx,
    data: {
      contentId: string;
      baseVersion: number;
      changes: object;
      changeNote: string;
      userId: string;
    },
  ): Promise<RevisionRow> {
    try {
      return toRevision(
        await tx.contentRevision.create({
          data: {
            contentId: data.contentId,
            baseVersion: data.baseVersion,
            changes: data.changes,
            changeNote: data.changeNote,
            requestedByUserId: data.userId,
          },
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictError('A correction is already pending for this item', {
          details: { reason: 'CORRECTION_PENDING' },
        });
      throw error;
    }
  }

  async findRevision(contentId: string, id: string, tx?: Tx): Promise<RevisionRow | null> {
    const row = await withPrismaErrors(() =>
      (tx ?? this.db).contentRevision.findFirst({ where: { id, contentId } }),
    );
    return row === null ? null : toRevision(row);
  }

  async listRevisions(contentId: string): Promise<RevisionRow[]> {
    const rows = await withPrismaErrors(() =>
      this.db.contentRevision.findMany({
        where: { contentId },
        orderBy: { requestedAt: 'desc' },
        take: 50,
      }),
    );
    return rows.map(toRevision);
  }

  async signOffRevision(tx: Tx, id: string, reviewerId: string): Promise<boolean> {
    const { count } = await tx.contentRevision.updateMany({
      where: { id, status: 'PENDING' },
      data: { signedOffById: reviewerId, signedOffAt: new Date() },
    });
    return count === 1;
  }

  async decideRevision(
    tx: Tx,
    id: string,
    status: 'APPLIED' | 'REJECTED',
    userId: string,
    rejectReason: string | null,
  ): Promise<boolean> {
    const { count } = await tx.contentRevision.updateMany({
      where: { id, status: 'PENDING' },
      data: { status, decidedByUserId: userId, decidedAt: new Date(), rejectReason },
    });
    return count === 1;
  }

  // ── Reader ──

  /** One feed page (cards only) for a reader segment. */
  async feed(
    segment: Segment,
    filter: { topicId?: string; kind?: ContentKind },
    sort: 'latest' | 'trending',
    page: { cursor?: string; limit: number },
  ): Promise<Paginated<CardRow>> {
    const rows = await withPrismaErrors(() =>
      this.db.contentItem.findMany({
        where: {
          status: 'PUBLISHED',
          deletedAt: null,
          ...(filter.topicId === undefined ? {} : { topicId: filter.topicId }),
          ...(filter.kind === undefined ? {} : { kind: filter.kind }),
          ...segmentWhere(segment),
        },
        select: CARD_SELECT,
        orderBy:
          sort === 'trending'
            ? [{ trendingScore: 'desc' }, { id: 'desc' }]
            : [{ publishedAt: 'desc' }, { id: 'desc' }],
        ...cursorArgs(page),
      }),
    );
    const out = toPage(rows, page.limit);
    return { ...out, items: out.items.map(toCard) };
  }

  /** Featured live cards for a segment (feed hero, first page only). */
  async featured(segment: Segment, limit: number): Promise<CardRow[]> {
    const rows = await withPrismaErrors(() =>
      this.db.contentItem.findMany({
        where: { status: 'PUBLISHED', deletedAt: null, isFeatured: true, ...segmentWhere(segment) },
        select: CARD_SELECT,
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
    );
    return rows.map(toCard);
  }

  /**
   * Full-text search (english; websearch syntax + prefix match on the last word), ranked.
   * Offset paging (search depth is capped by validation).
   */
  async search(
    q: string,
    segment: Segment,
    filter: { topicId?: string; kind?: ContentKind },
    offset: number,
    limit: number,
  ): Promise<{ items: CardRow[]; hasMore: boolean }> {
    const last = /([\p{L}\p{N}]+)\s*$/u.exec(q.toLowerCase())?.[1] ?? '';
    const prefix =
      last.length >= 2 ? Prisma.sql`|| to_tsquery('english', ${`${last}:*`})` : Prisma.empty;
    const rows = await withPrismaErrors(
      () =>
        this.db.$queryRaw<{ id: string }[]>`
        WITH q AS (SELECT (websearch_to_tsquery('english', ${q}) ${prefix}) AS query)
        SELECT c."id"::text AS id
        FROM "content_items" c, q
        WHERE c."status" = 'PUBLISHED' AND c."deletedAt" IS NULL
          AND c."searchVector" @@ q.query
          AND (cardinality(c."territoryCodes") = 0 OR ${segment.territoryCode}::text = ANY(c."territoryCodes"))
          AND (cardinality(c."productionTypes") = 0
               OR c."productionTypes" && ${segment.productionTypes}::text[]::"ProductionType"[])
          ${filter.topicId === undefined ? Prisma.empty : Prisma.sql`AND c."topicId" = ${filter.topicId}::uuid`}
          ${filter.kind === undefined ? Prisma.empty : Prisma.sql`AND c."kind" = ${filter.kind}::"ContentKind"`}
        ORDER BY ts_rank(c."searchVector", q.query) DESC, c."publishedAt" DESC, c."id" DESC
        OFFSET ${offset} LIMIT ${limit + 1}`,
    );
    const ids = rows.slice(0, limit).map((r) => r.id);
    const cards = await this.cardsByIds(ids, ['PUBLISHED']);
    return { items: cards, hasMore: rows.length > limit };
  }

  /** Cards by id, in the given order, only in the given statuses. */
  async cardsByIds(ids: readonly string[], statuses: readonly ContentStatus[]): Promise<CardRow[]> {
    if (ids.length === 0) return [];
    const rows = await withPrismaErrors(() =>
      this.db.contentItem.findMany({
        where: { id: { in: [...ids] }, deletedAt: null, status: { in: [...statuses] } },
        select: CARD_SELECT,
      }),
    );
    const byId = new Map(rows.map((r) => [r.id, toCard(r)]));
    return ids.flatMap((id) => {
      const card = byId.get(id);
      return card === undefined ? [] : [card];
    });
  }

  /** A readable item (PUBLISHED / EXPIRED / RETRACTED) by id or slug. */
  async findReadable(idOrSlug: string): Promise<ContentRow | null> {
    const isId = /^[0-9a-f-]{36}$/i.test(idOrSlug);
    const row = await withPrismaErrors(() =>
      this.db.contentItem.findFirst({
        where: {
          ...(isId ? { id: idOrSlug } : { slug: idOrSlug }),
          deletedAt: null,
          status: { in: ['PUBLISHED', 'EXPIRED', 'RETRACTED'] },
        },
        include: ITEM_INCLUDE,
      }),
    );
    return row === null ? null : toRow(row);
  }

  async findManyFull(ids: readonly string[]): Promise<ContentRow[]> {
    if (ids.length === 0) return [];
    const rows = await withPrismaErrors(() =>
      this.db.contentItem.findMany({
        where: { id: { in: [...ids] }, deletedAt: null },
        include: ITEM_INCLUDE,
      }),
    );
    return rows.map(toRow);
  }

  // ── Saves / feedback ──

  async findSave(userId: string, contentId: string) {
    return withPrismaErrors(() =>
      this.db.contentSave.findUnique({ where: { userId_contentId: { userId, contentId } } }),
    );
  }

  async savedIds(userId: string, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await withPrismaErrors(() =>
      this.db.contentSave.findMany({
        where: { userId, contentId: { in: [...ids] } },
        select: { contentId: true },
      }),
    );
    return new Set(rows.map((r) => r.contentId));
  }

  async countSaves(userId: string, offlineOnly: boolean): Promise<number> {
    return withPrismaErrors(() =>
      this.db.contentSave.count({ where: { userId, ...(offlineOnly ? { offline: true } : {}) } }),
    );
  }

  /** Insert or update a save; `created` = it did not exist before. */
  async upsertSave(
    userId: string,
    contentId: string,
    offline: boolean,
    downloadedVersion: number | null,
  ): Promise<{ created: boolean }> {
    const rows = await withPrismaErrors(
      () =>
        this.db.$queryRaw<{ created: boolean }[]>`
        INSERT INTO "content_saves" ("userId", "contentId", "offline", "downloadedVersion", "updatedAt")
        VALUES (${userId}::uuid, ${contentId}::uuid, ${offline}, ${downloadedVersion}, now())
        ON CONFLICT ("userId", "contentId") DO UPDATE
          SET "offline" = EXCLUDED."offline",
              "downloadedVersion" = COALESCE(EXCLUDED."downloadedVersion", "content_saves"."downloadedVersion"),
              "updatedAt" = now()
        RETURNING (xmax = 0) AS created`,
    );
    return { created: rows[0]?.created === true };
  }

  async deleteSave(userId: string, contentId: string): Promise<boolean> {
    const { count } = await withPrismaErrors(() =>
      this.db.contentSave.deleteMany({ where: { userId, contentId } }),
    );
    return count === 1;
  }

  /** A reader's saves, newest first (keyset on (savedAt, contentId)). */
  async library(
    userId: string,
    query: { offline?: boolean; cursor?: string; limit: number },
  ): Promise<{
    rows: {
      contentId: string;
      savedAt: Date;
      offline: boolean;
      downloadedVersion: number | null;
    }[];
    nextCursor: string | null;
  }> {
    const take = query.limit + 1;
    const rows = await withPrismaErrors(() =>
      this.db.contentSave.findMany({
        where: { userId, ...(query.offline === undefined ? {} : { offline: query.offline }) },
        orderBy: [{ savedAt: 'desc' }, { contentId: 'desc' }],
        take,
        ...(query.cursor === undefined
          ? {}
          : { skip: 1, cursor: { userId_contentId: { userId, contentId: query.cursor } } }),
      }),
    );
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return { rows: page, nextCursor: hasMore ? (page.at(-1)?.contentId ?? null) : null };
  }

  /** All offline saves of a reader (sync; capped by maxOfflinePerUser). */
  async offlineSaves(userId: string) {
    return withPrismaErrors(() =>
      this.db.contentSave.findMany({
        where: { userId, offline: true },
        select: { contentId: true, downloadedVersion: true },
      }),
    );
  }

  async findFeedback(userId: string, contentId: string): Promise<boolean | null> {
    const row = await withPrismaErrors(() =>
      this.db.contentFeedback.findUnique({ where: { userId_contentId: { userId, contentId } } }),
    );
    return row?.helpful ?? null;
  }

  /** Upsert a vote; returns the previous vote (null = first vote). */
  async upsertFeedback(
    userId: string,
    contentId: string,
    helpful: boolean,
  ): Promise<boolean | null> {
    const rows = await withPrismaErrors(
      () =>
        this.db.$queryRaw<{ previous: boolean | null }[]>`
        WITH prev AS (
          SELECT "helpful" FROM "content_feedback"
          WHERE "userId" = ${userId}::uuid AND "contentId" = ${contentId}::uuid
          FOR UPDATE
        ), up AS (
          INSERT INTO "content_feedback" ("userId", "contentId", "helpful", "updatedAt")
          VALUES (${userId}::uuid, ${contentId}::uuid, ${helpful}, now())
          ON CONFLICT ("userId", "contentId") DO UPDATE SET "helpful" = EXCLUDED."helpful", "updatedAt" = now()
          RETURNING 1
        )
        SELECT (SELECT "helpful" FROM prev) AS previous FROM up`,
    );
    return rows[0]?.previous ?? null;
  }

  // ── Push audience (internal) ──

  /** One keyset page (by user id) of readers who saved the item. */
  async saverIds(contentId: string, after: string | null, limit: number): Promise<string[]> {
    const rows = await withPrismaErrors(() =>
      this.db.contentSave.findMany({
        where: { contentId, ...(after === null ? {} : { userId: { gt: after } }) },
        select: { userId: true },
        orderBy: { userId: 'asc' },
        take: limit,
      }),
    );
    return rows.map((r) => r.userId);
  }

  // ── Jobs ──

  async dueScheduled(now: Date, limit: number): Promise<ContentRow[]> {
    const rows = await withPrismaErrors(() =>
      this.db.contentItem.findMany({
        where: { status: 'SCHEDULED', deletedAt: null, publishAt: { lte: now } },
        include: ITEM_INCLUDE,
        orderBy: { publishAt: 'asc' },
        take: limit,
      }),
    );
    return rows.map(toRow);
  }

  async dueExpiry(now: Date, limit: number): Promise<ContentRow[]> {
    const rows = await withPrismaErrors(() =>
      this.db.contentItem.findMany({
        where: { status: 'PUBLISHED', deletedAt: null, expiresAt: { lte: now } },
        include: ITEM_INCLUDE,
        orderBy: { expiresAt: 'asc' },
        take: limit,
      }),
    );
    return rows.map(toRow);
  }

  /** One batched UPDATE for all buffered counters (no per-view row writes). */
  async applyCounters(deltas: readonly CounterDelta[]): Promise<void> {
    if (deltas.length === 0) return;
    const values = Prisma.join(
      deltas.map(
        (d) =>
          Prisma.sql`(${d.id}::uuid, ${d.views}::int, ${d.yes}::int, ${d.no}::int, ${d.saves}::int, ${d.shares}::int)`,
      ),
    );
    await withPrismaErrors(
      () =>
        this.db.$executeRaw`
        UPDATE "content_items" c SET
          "viewCount"  = GREATEST(c."viewCount"  + v.views, 0),
          "helpfulYes" = GREATEST(c."helpfulYes" + v.yes, 0),
          "helpfulNo"  = GREATEST(c."helpfulNo"  + v.no, 0),
          "saveCount"  = GREATEST(c."saveCount"  + v.saves, 0),
          "shareCount" = GREATEST(c."shareCount" + v.shares, 0)
        FROM (VALUES ${values}) AS v(id, views, yes, no, saves, shares)
        WHERE c."id" = v.id`,
    );
  }

  /** Trending = engagement decayed by age (HN-style). Live items only. */
  async recomputeTrending(): Promise<number> {
    return withPrismaErrors(
      () =>
        this.db.$executeRaw`
        UPDATE "content_items" SET "trendingScore" =
          ("viewCount" + 3 * "helpfulYes" + 2 * "saveCount" + "shareCount")::float8
          / power(GREATEST(EXTRACT(EPOCH FROM (now() - COALESCE("publishedAt", now()))) / 3600, 0) + 2, 1.5)
        WHERE "status" = 'PUBLISHED' AND "deletedAt" IS NULL`,
    );
  }
}
