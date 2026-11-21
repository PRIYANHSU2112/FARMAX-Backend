import { createHash } from 'node:crypto';

import { ConflictError, NotFoundError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import { farmKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import { LocalCache } from '../../adapters/local-cache.js';
import type { ReaderContext } from '../farms/index.js';
import type { Segment } from './content.repository.js';
import { CONTENT_LIMITS, distanceBucket, syncAction } from './content.rules.js';
import type {
  Card,
  CardRow,
  ContentRow,
  Detail,
  FeedPage,
  FeedQuery,
  HeldCopy,
  LibraryItem,
  MyState,
  SearchQuery,
  SyncItem,
  TopicRow,
} from './content.types.js';

type Deps = Pick<Cradle, 'contentRepository' | 'contentCounters' | 'cache' | 'redis' | 'logger'> & {
  farmsService: Cradle['farmsService'];
};

const PAGE_TTL_SEC = 60;
const DETAIL_TTL_SEC = 300;
const READER_TTL_SEC = 300;
const FEATURED_LIMIT = 5;
const MAX_SEARCH_DEPTH = 500;
const DAY_MS = 86_400_000;

const hashKey = (value: unknown): string =>
  createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 24);

const segmentOf = (reader: ReaderContext | null): Segment => ({
  territoryCode: reader?.territoryCode ?? null,
  productionTypes: reader?.productionTypes ?? [],
});

/** What readers see: feed, search, detail, saves, library + offline sync. */
export class ContentService {
  private readonly topicsCache = new LocalCache<TopicRow[]>(1, 30_000);

  constructor(private readonly deps: Deps) {}

  // ── Cache generation ──

  /** Current content generation (embedded in feed/detail keys). */
  private async gen(): Promise<string> {
    try {
      return (await this.deps.redis.get(farmKeys.contentGen())) ?? '0';
    } catch {
      return '0';
    }
  }

  /** After any reader-visible change: one INCR retires every cached page and detail. */
  async invalidate(): Promise<void> {
    this.topicsCache.delete('all');
    await this.deps.redis.incr(farmKeys.contentGen()).catch((err: unknown) => {
      this.deps.logger.warn({ err }, 'content cache generation not bumped (TTL bounds staleness)');
    });
  }

  // ── Topics ──

  async topics(): Promise<Pick<TopicRow, 'code' | 'name'>[]> {
    return (await this.activeTopics()).map(({ code, name }) => ({ code, name }));
  }

  private async activeTopics(): Promise<TopicRow[]> {
    const hit = this.topicsCache.get('all');
    if (hit !== undefined) return hit;
    const rows = await this.deps.contentRepository.listTopics(true);
    this.topicsCache.set('all', rows);
    return rows;
  }

  /** undefined = no filter; null = unknown topic (empty result). */
  private async topicId(code: string | undefined): Promise<string | null | undefined> {
    if (code === undefined) return undefined;
    return (await this.activeTopics()).find((t) => t.code === code)?.id ?? null;
  }

  // ── Reader context (server-side only; never serialized) ──

  private reader(userId: string, farmId?: string): Promise<ReaderContext | null> {
    return this.deps.cache.getOrSet(
      farmKeys.contentReader(userId, farmId ?? '-'),
      READER_TTL_SEC,
      () => this.deps.farmsService.readerContext(userId, farmId),
    );
  }

  private toCard(row: CardRow, reader: ReaderContext | null, saved: ReadonlySet<string>): Card {
    const { area, ...rest } = row;
    return { ...rest, distance: distanceBucket(reader, area), saved: saved.has(row.id) };
  }

  // ── Feed / search ──

  async feed(userId: string, q: FeedQuery): Promise<FeedPage> {
    const [reader, topicId] = await Promise.all([
      this.reader(userId, q.farmId),
      this.topicId(q.topic),
    ]);
    if (topicId === null) return { featured: [], items: [], nextCursor: null, limit: q.limit };
    const segment = segmentOf(reader);
    const filter = {
      ...(topicId === undefined ? {} : { topicId }),
      ...(q.kind === undefined ? {} : { kind: q.kind }),
    };
    const firstPage = q.cursor === undefined && topicId === undefined && q.kind === undefined;
    const key = farmKeys.contentPage(
      await this.gen(),
      hashKey(['feed', segment, filter, q.sort, q.cursor ?? null, q.limit]),
    );
    const page = await this.deps.cache.getOrSet(key, PAGE_TTL_SEC, async () => {
      const [items, featured] = await Promise.all([
        this.deps.contentRepository.feed(segment, filter, q.sort, {
          ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
          limit: q.limit,
        }),
        firstPage ? this.deps.contentRepository.featured(segment, FEATURED_LIMIT) : [],
      ]);
      return { ...items, featured };
    });
    const saved = await this.deps.contentRepository.savedIds(
      userId,
      [...page.featured, ...page.items].map((c) => c.id),
    );
    return {
      featured: page.featured.map((c) => this.toCard(c, reader, saved)),
      items: page.items.map((c) => this.toCard(c, reader, saved)),
      nextCursor: page.nextCursor,
      limit: page.limit,
    };
  }

  async search(userId: string, q: SearchQuery): Promise<Paginated<Card>> {
    const [reader, topicId] = await Promise.all([
      this.reader(userId, q.farmId),
      this.topicId(q.topic),
    ]);
    if (topicId === null) return { items: [], nextCursor: null, limit: q.limit };
    const segment = segmentOf(reader);
    const offset = Number(q.cursor ?? '0');
    const filter = {
      ...(topicId === undefined ? {} : { topicId }),
      ...(q.kind === undefined ? {} : { kind: q.kind }),
    };
    const text = q.q.toLowerCase().replace(/\s+/g, ' ');
    const key = farmKeys.contentPage(
      await this.gen(),
      hashKey(['search', segment, filter, text, offset, q.limit]),
    );
    const found = await this.deps.cache.getOrSet(key, PAGE_TTL_SEC, () =>
      this.deps.contentRepository.search(text, segment, filter, offset, q.limit),
    );
    const saved = await this.deps.contentRepository.savedIds(
      userId,
      found.items.map((c) => c.id),
    );
    const next = offset + q.limit;
    return {
      items: found.items.map((c) => this.toCard(c, reader, saved)),
      nextCursor: found.hasMore && next < MAX_SEARCH_DEPTH ? String(next) : null,
      limit: q.limit,
    };
  }

  // ── Detail ──

  async detail(userId: string, idOrSlug: string, farmId?: string): Promise<Detail> {
    const [bundle, reader] = await Promise.all([
      this.deps.cache.getOrSet(
        farmKeys.contentDetail(await this.gen(), idOrSlug),
        DETAIL_TTL_SEC,
        async () => {
          const item = await this.deps.contentRepository.findReadable(idOrSlug);
          if (item === null) return null;
          const related =
            item.status === 'RETRACTED'
              ? []
              : await this.deps.contentRepository.cardsByIds(item.relatedIds, ['PUBLISHED']);
          return { item, related };
        },
      ),
      this.reader(userId, farmId),
    ]);
    if (bundle === null) throw new NotFoundError('Content');
    const { item, related } = bundle;
    const [me, saved] = await Promise.all([
      this.myState(userId, item.id),
      this.deps.contentRepository.savedIds(
        userId,
        related.map((c) => c.id),
      ),
    ]);
    if (item.status !== 'RETRACTED')
      void this.deps.contentCounters.view(item.id, userId).catch((err: unknown) => {
        this.deps.logger.warn({ err }, 'content view not recorded');
      });
    return this.toDetail(
      item,
      related.map((c) => this.toCard(c, reader, saved)),
      reader,
      me,
    );
  }

  private async myState(userId: string, contentId: string): Promise<MyState> {
    const [save, helpful] = await Promise.all([
      this.deps.contentRepository.findSave(userId, contentId),
      this.deps.contentRepository.findFeedback(userId, contentId),
    ]);
    return {
      saved: save !== null,
      offline: save?.offline ?? false,
      downloadedVersion: save?.downloadedVersion ?? null,
      helpful,
    };
  }

  /** Reader view. A withdrawn item shows only its title + the withdrawal note (no wrong advice). */
  private toDetail(
    item: ContentRow,
    related: Card[],
    reader: ReaderContext | null,
    me: MyState,
  ): Detail {
    const withdrawn = item.status === 'RETRACTED';
    const status = item.status as Detail['status'];
    return {
      id: item.id,
      slug: item.slug,
      kind: item.kind,
      status,
      topic: { code: item.topic.code, name: item.topic.name },
      title: item.title,
      summary: withdrawn ? null : item.summary,
      heroImageUrl: withdrawn ? null : item.heroImageUrl,
      blocks: withdrawn ? [] : item.blocks,
      sources: withdrawn ? [] : item.sources,
      ctas: withdrawn ? [] : item.ctas,
      tags: item.tags,
      asset: withdrawn ? null : item.asset,
      severity: item.severity,
      placeLabel: item.placeLabel,
      distance: distanceBucket(reader, item.area),
      readMinutes: item.readMinutes,
      reviewer:
        item.reviewer === null
          ? null
          : {
              name: item.reviewer.displayName,
              qualification: item.reviewer.qualification,
              registrationNo: item.reviewer.registrationNo,
            },
      publishedAt: item.publishedAt,
      expiresAt: item.expiresAt,
      ended:
        item.status === 'EXPIRED'
          ? { at: item.expiredAt ?? item.expiresAt ?? item.updatedAt }
          : null,
      correction:
        item.lastCorrectedAt === null || item.correctionNote === null
          ? null
          : { at: item.lastCorrectedAt, note: item.correctionNote },
      withdrawn:
        withdrawn && item.retractedAt !== null
          ? { at: item.retractedAt, note: item.retractNote ?? 'This item was withdrawn.' }
          : null,
      contentVersion: item.contentVersion,
      viewCount: item.viewCount,
      helpful: { yes: item.helpfulYes, no: item.helpfulNo },
      related,
      me,
    };
  }

  // ── Save / feedback / share ──

  private async mustPublished(id: string): Promise<ContentRow> {
    const item = await this.deps.contentRepository.findById(id);
    if (item === null || !['PUBLISHED', 'EXPIRED'].includes(item.status))
      throw new NotFoundError('Content');
    return item;
  }

  async save(
    userId: string,
    id: string,
    input: { offline: boolean; downloadedVersion?: number | null },
  ): Promise<MyState> {
    const { contentRepository: repo } = this.deps;
    const item = await this.mustPublished(id);
    if (item.status !== 'PUBLISHED')
      throw new ConflictError('This alert has ended and can no longer be saved', {
        details: { reason: 'CONTENT_ENDED' },
      });
    const existing = await repo.findSave(userId, id);
    if (
      existing === null &&
      (await repo.countSaves(userId, false)) >= CONTENT_LIMITS.maxSavesPerUser
    )
      throw new ConflictError('Your library is full; remove some saved items', {
        details: { reason: 'SAVE_LIMIT', limit: CONTENT_LIMITS.maxSavesPerUser },
      });
    if (
      input.offline &&
      existing?.offline !== true &&
      (await repo.countSaves(userId, true)) >= CONTENT_LIMITS.maxOfflinePerUser
    )
      throw new ConflictError('Too many offline downloads; remove some first', {
        details: { reason: 'OFFLINE_LIMIT', limit: CONTENT_LIMITS.maxOfflinePerUser },
      });
    const reported = input.downloadedVersion ?? null;
    const downloaded = reported === null ? null : Math.min(reported, item.contentVersion);
    const { created } = await repo.upsertSave(userId, id, input.offline, downloaded);
    if (created) this.deps.contentCounters.bump(id, 'saves', 1);
    return this.myState(userId, id);
  }

  async unsave(userId: string, id: string): Promise<void> {
    if (await this.deps.contentRepository.deleteSave(userId, id))
      this.deps.contentCounters.bump(id, 'saves', -1);
  }

  async feedback(userId: string, id: string, helpful: boolean): Promise<MyState> {
    await this.mustPublished(id);
    const previous = await this.deps.contentRepository.upsertFeedback(userId, id, helpful);
    const { contentCounters: counters } = this.deps;
    if (previous !== helpful) {
      counters.bump(id, helpful ? 'yes' : 'no', 1);
      if (previous !== null) counters.bump(id, previous ? 'yes' : 'no', -1);
    }
    return this.myState(userId, id);
  }

  async share(id: string): Promise<void> {
    await this.mustPublished(id);
    this.deps.contentCounters.bump(id, 'shares', 1);
  }

  // ── Library + offline sync ──

  async library(
    userId: string,
    query: { offline?: boolean; cursor?: string; limit: number },
  ): Promise<Paginated<LibraryItem>> {
    const page = await this.deps.contentRepository.library(userId, query);
    const items = await this.deps.contentRepository.findManyFull(page.rows.map((r) => r.contentId));
    const byId = new Map(items.map((i) => [i.id, i]));
    return {
      items: page.rows.flatMap((save) => {
        const item = byId.get(save.contentId);
        if (item === undefined) return [];
        return [
          {
            id: item.id,
            slug: item.slug,
            kind: item.kind,
            topic: { code: item.topic.code, name: item.topic.name },
            title: item.title,
            summary: item.status === 'RETRACTED' ? '' : item.summary,
            heroImageUrl: item.heroImageUrl,
            readMinutes: item.readMinutes,
            publishedAt: item.publishedAt,
            isFeatured: item.isFeatured,
            severity: item.severity,
            placeLabel: item.placeLabel,
            assetKind: item.asset?.kind ?? null,
            durationSec: item.asset?.durationSec ?? null,
            pageCount: item.asset?.pageCount ?? null,
            viewCount: item.viewCount,
            distance: null,
            saved: true,
            savedAt: save.savedAt.toISOString(),
            offline: save.offline,
            downloadedVersion: save.downloadedVersion,
            contentVersion: item.contentVersion,
            status: item.status,
            asset: item.status === 'RETRACTED' ? null : item.asset,
          },
        ];
      }),
      nextCursor: page.nextCursor,
      limit: query.limit,
    };
  }

  /**
   * Offline reconciliation. The device reports the copies it holds; the server answers per item:
   * KEEP · REPLACE (corrected / updated: full payload) · DOWNLOAD (saved offline elsewhere) ·
   * MARK_ENDED (alert expired: keep with banner, delete after 7 days) · DELETE (withdrawn,
   * archived, unsaved). Read-only and fast: one query for saves, one for items.
   */
  async sync(
    userId: string,
    held: readonly HeldCopy[],
  ): Promise<{ items: SyncItem[]; serverTime: string; revalidateBy: string }> {
    const now = new Date();
    const saves = await this.deps.contentRepository.offlineSaves(userId);
    const offline = new Map(saves.map((s) => [s.contentId, s]));
    const heldBy = new Map(held.map((h) => [h.contentId, h.version]));
    const ids = [...new Set([...heldBy.keys(), ...offline.keys()])];
    const rows = await this.deps.contentRepository.findManyFull(ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items: SyncItem[] = [];
    for (const contentId of ids) {
      const item = byId.get(contentId) ?? null;
      const save = offline.get(contentId);
      const action = syncAction(heldBy.get(contentId) ?? null, save !== undefined, item, now);
      if (action === null) continue;
      const withPayload = item !== null && (action === 'REPLACE' || action === 'DOWNLOAD');
      items.push({
        contentId,
        action,
        contentVersion: item?.contentVersion ?? null,
        item: withPayload
          ? this.toDetail(item, [], null, {
              saved: true,
              offline: true,
              downloadedVersion: save?.downloadedVersion ?? null,
              helpful: null,
            })
          : null,
        note: noteFor(action, item),
      });
    }
    return {
      items,
      serverTime: now.toISOString(),
      revalidateBy: new Date(now.getTime() + CONTENT_LIMITS.revalidateDays * DAY_MS).toISOString(),
    };
  }

  // ── Push audience (notification-service fan-out, internal) ──

  /**
   * One keyset page (by user id) of an item's readers: its target segment (owners with an
   * ACTIVE farm), its savers, or both. A k-way merge of two keyset pages: ids not returned by a
   * source are always above the page's last id, so no reader is skipped or repeated.
   */
  async audience(
    contentId: string,
    scope: 'segment' | 'savers' | 'both',
    cursor: string | null,
    limit: number,
  ): Promise<{ ids: string[]; nextCursor: string | null }> {
    const item = await this.deps.contentRepository.findById(contentId);
    if (item === null) throw new NotFoundError('Content');
    const [segment, savers] = await Promise.all([
      scope === 'savers'
        ? []
        : this.deps.farmsService.segmentOwnerIds(
            { territoryCodes: item.territoryCodes, productionTypes: item.productionTypes },
            cursor,
            limit,
          ),
      scope === 'segment' ? [] : this.deps.contentRepository.saverIds(contentId, cursor, limit),
    ]);
    const merged = [...new Set([...segment, ...savers])].sort();
    const ids = merged.slice(0, limit);
    const more = segment.length === limit || savers.length === limit || merged.length > limit;
    return { ids, nextCursor: more && ids.length > 0 ? (ids.at(-1) ?? null) : null };
  }
}

const noteFor = (action: SyncItem['action'], item: ContentRow | null): string | null => {
  if (item === null) return null;
  if (action === 'REPLACE') return item.correctionNote;
  if (action === 'MARK_ENDED')
    return `This alert ended on ${(item.expiredAt ?? item.expiresAt ?? '').slice(0, 10)}.`;
  if (action === 'DELETE' && item.status === 'RETRACTED') return item.retractNote;
  return null;
};
