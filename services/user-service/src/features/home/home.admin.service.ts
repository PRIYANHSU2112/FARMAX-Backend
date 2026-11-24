import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import type { Cradle } from '@fastify/awilix';

import type { Actor, AuditRecord } from '../audit/index.js';
import { previewContext } from './home.context.js';
import { futureFactsOf } from './home.rules.js';
import type {
  AdminListQuery,
  CreateLayoutInput,
  HomeMeta,
  LayoutRow,
  LayoutSummary,
  LayoutTree,
  LayoutView,
  PreviewQuery,
  PublishInput,
  ReplaceLayoutInput,
  SectionInput,
  SectionRow,
} from './home.types.js';
import { LIMITS } from './home.validation.js';
import { type Issue, checkSection } from './home.widgets.js';

type Deps = Pick<
  Cradle,
  | 'homeRepository'
  | 'homeService'
  | 'auditService'
  | 'runInTransaction'
  | 'productClient'
  | 'catalogClient'
  | 'config'
  | 'logger'
>;

/** Admin calls can wait longer than the app (publish is rare and must be right). */
const REF_TIMEOUT_MS = 2_000;

export interface BrokenRef {
  sectionKey: string;
  itemId: string | null;
  refType: string;
  ref: string;
  label: string;
  /** false = disabled item or section: marked, but it does not block publishing. */
  active: boolean;
}

export interface Warning {
  path: string;
  message: string;
}

// ── Pure helpers (exported for unit tests) ──

export const hostsOf = (csv: string): string[] =>
  csv
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== '');

/** Exact host or a subdomain of an allowed host. */
export const hostAllowed = (url: string, hosts: readonly string[]): boolean => {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
};

/** Every `deepLink` and image `url` inside a widget config, with its path. */
const linksIn = (
  value: unknown,
  path: string,
  out: { path: string; kind: 'link' | 'image'; url: string }[],
) => {
  if (typeof value !== 'object' || value === null) return out;
  for (const [k, v] of Object.entries(value)) {
    const at = `${path}.${k}`;
    if (k === 'deepLink' && typeof v === 'string') out.push({ path: at, kind: 'link', url: v });
    else if (k === 'url' && typeof v === 'string') out.push({ path: at, kind: 'image', url: v });
    else linksIn(v, at, out);
  }
  return out;
};

/** Sections back into the PUT body shape (clone). */
export const toInput = (s: SectionRow): SectionInput => ({
  sectionKey: s.sectionKey,
  widgetType: s.widgetType,
  dataSource: s.dataSource,
  feedKey: s.feedKey,
  eyebrow: s.eyebrow,
  title: s.title,
  subtitle: s.subtitle,
  viewAllLink: s.viewAllLink,
  displayOrder: s.displayOrder,
  isEnabled: s.isEnabled,
  itemLimit: s.itemLimit,
  minItems: s.minItems,
  inline: s.inline,
  experimentKey: s.experimentKey,
  config: s.config,
  targeting: s.targeting,
  items: s.items.map((i) => ({
    refType: i.refType,
    refId: i.refId,
    refCode: i.refCode,
    label: i.label,
    subtitle: i.subtitle,
    badge: i.badge,
    image: i.image,
    deepLink: i.deepLink,
    displayOrder: i.displayOrder,
    isEnabled: i.isEnabled,
    targeting: i.targeting,
  })),
});

/**
 * Rules over the whole draft: unique keys, ≤ 3 inline product sections, per-widget rules
 * (home.widgets.ts), allowlisted link / image hosts. Returns the sections with config defaults.
 */
export function checkLayout(
  sections: readonly SectionInput[],
  hosts: { links: readonly string[]; images: readonly string[] },
): { issues: Issue[]; sections: SectionInput[]; warnings: Warning[] } {
  const issues: Issue[] = [];
  const warnings: Warning[] = [];
  const seen = new Set<string>();
  let inline = 0;
  const checked = sections.map((section, index) => {
    const at = `body.sections.${String(index)}`;
    if (seen.has(section.sectionKey))
      issues.push({
        path: `${at}.sectionKey`,
        message: `duplicate section key "${section.sectionKey}"`,
      });
    seen.add(section.sectionKey);
    if (section.inline) {
      inline += 1;
      if (inline > LIMITS.inline)
        issues.push({
          path: `${at}.inline`,
          message: `at most ${String(LIMITS.inline)} sections can be inline`,
        });
    }
    const { issues: own, config } = checkSection(section, index);
    issues.push(...own);

    const links: { path: string; kind: 'link' | 'image'; url: string }[] = [];
    if (section.viewAllLink !== null)
      links.push({ path: `${at}.viewAllLink`, kind: 'link', url: section.viewAllLink });
    linksIn(config, `${at}.config`, links);
    section.items.forEach((item, i) => {
      links.push({ path: `${at}.items.${String(i)}.deepLink`, kind: 'link', url: item.deepLink });
      if (item.image !== null)
        links.push({
          path: `${at}.items.${String(i)}.image.url`,
          kind: 'image',
          url: item.image.url,
        });
      for (const fact of futureFactsOf(item.targeting))
        warnings.push({
          path: `${at}.items.${String(i)}.targeting.${fact}`,
          message: `${fact} has no data yet (Future): this item will not show`,
        });
    });
    for (const link of links) {
      if (link.kind === 'link' && link.url.startsWith('farmx://')) continue;
      const allowed = link.kind === 'link' ? hosts.links : hosts.images;
      if (!hostAllowed(link.url, allowed))
        issues.push({
          path: link.path,
          message: `host not allowed (allowed: ${allowed.join(', ') || 'none'})`,
        });
    }
    for (const fact of futureFactsOf(section.targeting))
      warnings.push({
        path: `${at}.targeting.${fact}`,
        message: `${fact} has no data yet (Future): this section will not show`,
      });
    return { ...section, config };
  });
  return { issues, sections: checked, warnings };
}

const ifMatchRequired = (ifMatch: number | undefined): number => {
  if (ifMatch === undefined)
    throw new BadRequestError('If-Match header is required (the layout version you loaded)', {
      details: { reason: 'IF_MATCH_REQUIRED' },
    });
  return ifMatch;
};

const conflict = () =>
  new ConflictError('The layout was changed by someone else; reload and retry', {
    details: { reason: 'HOME_LAYOUT_VERSION_CONFLICT' },
  });

/**
 * Admin CMS for home layouts. Only DRAFTs are edited; publish / schedule / rollback re-check
 * every reference first. Every write: If-Match version guard, one transaction, an audit row;
 * caches dropped after commit.
 */
export class HomeAdminService {
  constructor(private readonly deps: Deps) {}

  list(query: AdminListQuery): Promise<Paginated<LayoutSummary>> {
    return this.deps.homeRepository.list(query);
  }

  async get(id: string): Promise<LayoutTree> {
    const tree = await this.deps.homeRepository.tree(id);
    if (tree === null)
      throw new NotFoundError('Home layout', { details: { reason: 'HOME_LAYOUT_NOT_FOUND' } });
    return tree;
  }

  async history(
    id: string,
    query: { cursor?: string; limit: number },
  ): Promise<Paginated<AuditRecord>> {
    await this.row(id);
    return this.deps.auditService.history('home_layout', id, query);
  }

  async create(input: CreateLayoutInput, actor: Actor): Promise<LayoutTree> {
    const repo = this.deps.homeRepository;
    const id = await this.deps.runInTransaction(async (tx) => {
      await repo.lockPage(tx, input.page);
      let source: LayoutTree | null = null;
      if (input.cloneFromId !== undefined) {
        source = await repo.tree(input.cloneFromId, tx);
        if (source === null)
          throw new NotFoundError('Home layout to clone', {
            details: { reason: 'HOME_LAYOUT_NOT_FOUND' },
          });
        if (source.page !== input.page)
          throw new ValidationError(
            [{ path: 'body.cloneFromId', message: `that layout is for page ${source.page}` }],
            'Cannot clone across pages',
          );
      }
      const row = await repo.create(tx, {
        page: input.page,
        layoutNo: await repo.nextLayoutNo(tx, input.page),
        name: input.name,
        notes: input.notes ?? null,
        settings: source?.settings ?? {},
        userId: actor.userId,
      });
      if (source !== null) await repo.replaceSections(tx, row.id, source.sections.map(toInput));
      await this.deps.auditService.record(tx, actor, {
        action: 'home_layout.create',
        targetType: 'home_layout',
        targetId: row.id,
        after: { page: row.page, layoutNo: row.layoutNo, clonedFrom: source?.id ?? null },
      });
      return row.id;
    });
    return this.get(id);
  }

  async replace(
    id: string,
    input: ReplaceLayoutInput,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<{ layout: LayoutTree; warnings: Warning[] }> {
    const version = ifMatchRequired(ifMatch);
    const { config } = this.deps;
    const { issues, sections, warnings } = checkLayout(input.sections, {
      links: hostsOf(config.HOME_LINK_HOSTS),
      images: hostsOf(config.HOME_IMAGE_HOSTS),
    });
    if (issues.length > 0) throw new ValidationError(issues, 'Layout has errors');
    const layout = await this.row(id);
    this.assertStatus(layout, ['DRAFT'], 'Only a DRAFT layout can be edited; clone it first');

    await this.deps.runInTransaction(async (tx) => {
      const repo = this.deps.homeRepository;
      const ok = await repo.update(
        tx,
        id,
        { version, status: 'DRAFT' },
        {
          name: input.name,
          notes: input.notes ?? null,
          settings: input.settings ?? {},
          updatedByUserId: actor.userId,
        },
      );
      if (!ok) throw conflict();
      await repo.replaceSections(tx, id, sections);
      await this.deps.auditService.record(tx, actor, {
        action: 'home_layout.update',
        targetType: 'home_layout',
        targetId: id,
        before: { version: layout.version },
        after: {
          version: version + 1,
          sections: sections.length,
          items: sections.reduce((n, s) => n + s.items.length, 0),
        },
      });
    });
    return { layout: await this.get(id), warnings };
  }

  async reorder(
    id: string,
    keys: readonly string[],
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<LayoutTree> {
    const version = ifMatchRequired(ifMatch);
    const tree = await this.get(id);
    this.assertStatus(tree, ['DRAFT'], 'Only a DRAFT layout can be reordered');
    const existing = new Set(tree.sections.map((s) => s.sectionKey));
    if (keys.length !== existing.size || keys.some((k) => !existing.has(k)))
      throw new ValidationError(
        [
          {
            path: 'body.keys',
            message: `must list every section key once: ${[...existing].join(', ')}`,
          },
        ],
        'Reorder must list every section',
      );
    await this.deps.runInTransaction(async (tx) => {
      const repo = this.deps.homeRepository;
      const ok = await repo.update(
        tx,
        id,
        { version, status: 'DRAFT' },
        {
          updatedByUserId: actor.userId,
        },
      );
      if (!ok) throw conflict();
      await repo.setDisplayOrder(tx, id, keys);
      await this.deps.auditService.record(tx, actor, {
        action: 'home_layout.reorder',
        targetType: 'home_layout',
        targetId: id,
        before: { keys: tree.sections.map((s) => s.sectionKey) },
        after: { keys },
      });
    });
    return this.get(id);
  }

  async preview(id: string, query: PreviewQuery): Promise<{ view: LayoutView; meta: HomeMeta }> {
    return this.deps.homeService.preview(await this.get(id), previewContext(query));
  }

  /** Runs the ref check and stores the result on each item (`refBroken`). */
  async validate(id: string, actor: Actor): Promise<{ broken: BrokenRef[]; blocking: number }> {
    const tree = await this.get(id);
    const broken = await this.refCheck(tree);
    await this.deps.runInTransaction(async (tx) => {
      await this.deps.homeRepository.markBroken(tx, id, brokenItemIds(broken));
      await this.deps.auditService.record(tx, actor, {
        action: 'home_layout.validate',
        targetType: 'home_layout',
        targetId: id,
        after: { broken: broken.length },
      });
    });
    if (tree.status === 'PUBLISHED') await this.deps.homeService.invalidate(tree.page);
    return { broken, blocking: broken.filter((b) => b.active).length };
  }

  /** Publish now, or schedule (one SCHEDULED per page: a new schedule replaces the old one). */
  async publish(
    id: string,
    input: PublishInput,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<LayoutTree> {
    const version = ifMatchRequired(ifMatch);
    const tree = await this.get(id);
    this.assertStatus(
      tree,
      ['DRAFT', 'SCHEDULED'],
      'Only a DRAFT or SCHEDULED layout can be published',
    );
    if (tree.sections.length === 0)
      throw new ValidationError(
        [{ path: 'params.id', message: 'the layout has no sections' }],
        'Cannot publish an empty layout',
      );
    const broken = await this.assertRefs(tree);
    const repo = this.deps.homeRepository;

    await this.deps.runInTransaction(async (tx) => {
      await repo.lockPage(tx, tree.page);
      const fresh = await repo.findRow(id, tx);
      if (fresh?.version !== version) throw conflict();
      await repo.markBroken(tx, id, brokenItemIds(broken));
      if (input.scheduledPublishAt === undefined) {
        await this.deps.homeService.makeLive(
          tx,
          fresh,
          actor,
          'home_layout.publish',
          input.reason,
          {
            version,
          },
        );
        return;
      }
      const other = await repo.scheduled(tree.page, tx);
      if (other !== null && other.id !== id) {
        await repo.update(
          tx,
          other.id,
          { status: 'SCHEDULED' },
          {
            status: 'DRAFT',
            scheduledPublishAt: null,
            updatedByUserId: actor.userId,
          },
        );
        await this.deps.auditService.record(tx, actor, {
          action: 'home_layout.unschedule',
          targetType: 'home_layout',
          targetId: other.id,
          before: { status: 'SCHEDULED', scheduledPublishAt: other.scheduledPublishAt },
          after: { status: 'DRAFT', replacedBy: id },
          reason: input.reason,
        });
      }
      const ok = await repo.update(
        tx,
        id,
        { version },
        {
          status: 'SCHEDULED',
          scheduledPublishAt: input.scheduledPublishAt,
          publishedByUserId: actor.userId,
          updatedByUserId: actor.userId,
        },
      );
      if (!ok) throw conflict();
      await this.deps.auditService.record(tx, actor, {
        action: 'home_layout.schedule',
        targetType: 'home_layout',
        targetId: id,
        before: { status: tree.status },
        after: { status: 'SCHEDULED', scheduledPublishAt: input.scheduledPublishAt },
        reason: input.reason,
      });
    });
    await this.deps.homeService.invalidate(tree.page);
    return this.get(id);
  }

  /** Re-publish an ARCHIVED layout as-is (same ref check as publish). */
  async rollback(
    id: string,
    reason: string,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<LayoutTree> {
    const version = ifMatchRequired(ifMatch);
    const tree = await this.get(id);
    this.assertStatus(tree, ['ARCHIVED'], 'Only an ARCHIVED layout can be rolled back to');
    const broken = await this.assertRefs(tree);
    const repo = this.deps.homeRepository;
    await this.deps.runInTransaction(async (tx) => {
      await repo.lockPage(tx, tree.page);
      const fresh = await repo.findRow(id, tx);
      if (fresh?.version !== version || fresh.status !== 'ARCHIVED') throw conflict();
      await repo.markBroken(tx, id, brokenItemIds(broken));
      await this.deps.homeService.makeLive(tx, fresh, actor, 'home_layout.rollback', reason, {
        version,
        status: 'ARCHIVED',
      });
    });
    await this.deps.homeService.invalidate(tree.page);
    return this.get(id);
  }

  // ── Reference check ──

  /** Blocks publish / rollback when an ACTIVE item points at something gone (422). */
  private async assertRefs(tree: LayoutTree): Promise<BrokenRef[]> {
    const broken = await this.refCheck(tree);
    const blocking = broken.filter((b) => b.active);
    if (blocking.length > 0)
      throw new ValidationError(
        blocking.map((b) => ({
          path: `sections.${b.sectionKey}${b.itemId === null ? '' : `.items.${b.itemId}`}`,
          message: `${b.refType} ${b.ref} (${b.label}) no longer exists or is not on sale`,
        })),
        'Layout points to deleted or hidden catalog data (HOME_LAYOUT_BROKEN_REFS)',
      );
    return broken;
  }

  /**
   * Checks every referenced category, brand, disease, flock stage, product and banner placement
   * against its owning service. Can't verify (service down) → 503: never publish blind.
   */
  async refCheck(tree: LayoutTree): Promise<BrokenRef[]> {
    const want = { CATEGORY: false, DISEASE: false, FLOCK_STAGE: false };
    const brandIds = new Set<string>();
    const productIds = new Set<string>();
    const placements = new Set<string>();
    for (const s of tree.sections) {
      if (s.dataSource === 'BANNER_PLACEMENT' && typeof s.config.placementCode === 'string')
        placements.add(s.config.placementCode);
      for (const i of s.items) {
        if (i.refType === 'CATEGORY') want.CATEGORY = true;
        if (i.refType === 'DISEASE') want.DISEASE = true;
        if (i.refType === 'FLOCK_STAGE') want.FLOCK_STAGE = true;
        if (i.refType === 'BRAND' && i.refId !== null) brandIds.add(i.refId);
        if (i.refType === 'PRODUCT' && i.refId !== null) productIds.add(i.refId);
      }
    }
    const { catalogClient: catalog, productClient: products } = this.deps;
    const t = REF_TIMEOUT_MS;
    let lookups;
    try {
      lookups = await Promise.all([
        want.CATEGORY ? catalog.categoryIds(t) : Promise.resolve(new Set<string>()),
        want.DISEASE ? products.diseaseIds(t) : Promise.resolve(new Set<string>()),
        want.FLOCK_STAGE ? products.flockStageCodes(t) : Promise.resolve(new Set<string>()),
        Promise.all(
          [...brandIds].map(async (id) => [id, await catalog.brandExists(id, t)] as const),
        ),
        products.cards([...productIds], t),
        Promise.all(
          [...placements].map(
            async (code) => [code, (await catalog.placement(code, t)) !== null] as const,
          ),
        ),
      ]);
    } catch (err) {
      this.deps.logger.warn({ err }, 'home ref check: a catalog service is unavailable');
      throw new ServiceUnavailableError(
        'Cannot verify catalog references right now (catalog or product service unavailable)',
      );
    }
    const [categories, diseases, stages, brands, cards, placementOk] = lookups;
    const brandOk = new Map(brands);
    const placementLive = new Map(placementOk);

    const broken: BrokenRef[] = [];
    for (const s of tree.sections) {
      const code = s.config.placementCode;
      if (
        s.dataSource === 'BANNER_PLACEMENT' &&
        typeof code === 'string' &&
        placementLive.get(code) !== true
      )
        broken.push({
          sectionKey: s.sectionKey,
          itemId: null,
          refType: 'BANNER_PLACEMENT',
          ref: code,
          label: code,
          active: s.isEnabled,
        });
      for (const i of s.items) {
        const ref = i.refId ?? i.refCode ?? '';
        const gone =
          (i.refType === 'CATEGORY' && !categories.has(ref)) ||
          (i.refType === 'DISEASE' && !diseases.has(ref)) ||
          (i.refType === 'FLOCK_STAGE' && !stages.has(ref)) ||
          (i.refType === 'BRAND' && brandOk.get(ref) !== true) ||
          (i.refType === 'PRODUCT' && cards.get(ref)?.available !== true);
        if (gone)
          broken.push({
            sectionKey: s.sectionKey,
            itemId: i.id,
            refType: i.refType,
            ref,
            label: i.label.en,
            active: s.isEnabled && i.isEnabled,
          });
      }
    }
    return broken;
  }

  // ── Helpers ──

  private async row(id: string): Promise<LayoutRow> {
    const row = await this.deps.homeRepository.findRow(id);
    if (row === null)
      throw new NotFoundError('Home layout', { details: { reason: 'HOME_LAYOUT_NOT_FOUND' } });
    return row;
  }

  private assertStatus(layout: LayoutRow, allowed: readonly string[], message: string): void {
    if (!allowed.includes(layout.status))
      throw new ConflictError(message, {
        details: { reason: 'HOME_LAYOUT_WRONG_STATUS', status: layout.status },
      });
  }
}

const brokenItemIds = (broken: readonly BrokenRef[]): string[] =>
  broken.flatMap((b) => (b.itemId === null ? [] : [b.itemId]));
