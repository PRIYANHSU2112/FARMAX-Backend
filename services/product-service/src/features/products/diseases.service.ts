import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import { productKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import type { Actor } from '../audit/index.js';
import type {
  CreateDiseaseInput,
  DiseaseListQuery,
  DiseaseRecord,
  PublicDisease,
  PublicDiseaseQuery,
  UpdateDiseaseInput,
} from './diseases.types.js';
import { firstFreeSlug, slugify } from './products.helpers.js';

type Deps = Pick<
  Cradle,
  | 'diseasesRepository'
  | 'productsRepository'
  | 'catalogClient'
  | 'runInTransaction'
  | 'auditService'
  | 'cache'
  | 'redis'
  | 'logger'
>;

/** Storefront product filter (built by `productsRepository.storefrontWhere`). */
type ProductWhere = ReturnType<Cradle['productsRepository']['storefrontWhere']>;

const LIST_TTL_SECONDS = 60;
const SLUG_MAX = 100;
const listKey = (version: string) => productKeys.keyspace.key('diseases', version);

const blank = (v: string | null | undefined) =>
  v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim();

/**
 * "Shop by Problem" master data. Admins add / rename / reorder / (de)activate diseases; nothing is
 * hard-coded. Delete is soft only and refused while an active product is linked. Public cards are
 * cached per product list version, so every product, disease and lookup write expires them.
 */
export class DiseasesService {
  constructor(private readonly deps: Deps) {}

  private get repo() {
    return this.deps.diseasesRepository;
  }

  // ── Storefront ──

  async publicList(query: PublicDiseaseQuery): Promise<PublicDisease[]> {
    const version = (await this.deps.redis.get(productKeys.listVersion()).catch(() => null)) ?? '0';
    const cards = await this.deps.cache.getOrSet(listKey(version), LIST_TTL_SECONDS, () =>
      this.loadCards(),
    );
    return query.hideEmpty === true ? cards.filter((c) => c.productCount > 0) : cards;
  }

  /** Storefront-visible products per disease within `productWhere` (filters facet). */
  productCounts(productWhere: ProductWhere): Promise<Map<string, number>> {
    return this.repo.productCounts(productWhere);
  }

  activeAll(): Promise<DiseaseRecord[]> {
    return this.repo.activeAll();
  }

  /** Live + active disease ids for these slugs (unknown / inactive / deleted slugs are dropped). */
  activeIdsBySlugs(slugs: readonly string[]): Promise<string[]> {
    return this.repo.activeIdsBySlugs(slugs);
  }

  private async loadCards(): Promise<PublicDisease[]> {
    const { catalogClient } = this.deps;
    const [visible, brands] = await Promise.all([
      catalogClient.visibleCategoryIds(),
      catalogClient.activeBrands(),
    ]);
    // Same visibility as the product list: published, active, live, ≥1 active variant, category
    // visible, brand active.
    const where = this.deps.productsRepository.storefrontWhere({
      ...(visible === undefined ? {} : { categoryIds: [...visible] }),
      ...(brands === undefined ? {} : { brandIds: [...brands.keys()] }),
      attrs: [],
    });
    const [diseases, counts] = await Promise.all([
      this.repo.activeAll(),
      this.repo.productCounts(where),
    ]);
    return diseases.map(({ id, name, slug, description, iconUrl }) => ({
      id,
      name,
      slug,
      description,
      iconUrl,
      productCount: counts.get(id) ?? 0,
    }));
  }

  // ── Admin ──

  list(query: DiseaseListQuery): Promise<DiseaseRecord[]> {
    return this.repo.list(query);
  }

  async detail(id: string): Promise<DiseaseRecord> {
    const row = await this.repo.findLive(id);
    if (row === null) throw new NotFoundError('Disease');
    return row;
  }

  async create(input: CreateDiseaseInput, actor: Actor): Promise<DiseaseRecord> {
    const { reason, slug: wantedSlug, ...fields } = input;
    const name = fields.name.trim();
    const row = await this.deps.runInTransaction(async (tx) => {
      await this.assertNameFree(tx, name);
      const slug = await this.chooseSlug(tx, name, wantedSlug);
      const created = await this.repo.create(
        tx,
        {
          ...fields,
          name,
          slug,
          description: blank(fields.description) ?? null,
          iconUrl: blank(fields.iconUrl) ?? null,
        },
        actor.userId,
      );
      await this.deps.auditService.record(tx, actor, {
        action: 'disease.create',
        targetType: 'disease',
        targetId: created.id,
        after: created,
        reason,
      });
      return created;
    });
    await this.invalidate([]);
    return row;
  }

  async update(
    id: string,
    input: UpdateDiseaseInput,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<DiseaseRecord> {
    const { reason, ...rest } = input;
    const changes = {
      ...rest,
      ...(rest.name === undefined ? {} : { name: rest.name.trim() }),
      ...(rest.description === undefined ? {} : { description: blank(rest.description) ?? null }),
      ...(rest.iconUrl === undefined ? {} : { iconUrl: blank(rest.iconUrl) ?? null }),
    };
    const row = await this.deps.runInTransaction(async (tx) => {
      const current = await this.liveOrThrow(tx, id, ifMatch);
      if (changes.name !== undefined && changes.name !== current.name)
        await this.assertNameFree(tx, changes.name, id);
      if (changes.slug !== undefined && changes.slug !== current.slug)
        await this.assertSlugFree(tx, changes.slug, id);
      const updated = await this.repo.update(tx, id, changes, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'disease.update',
        targetType: 'disease',
        targetId: id,
        before: current,
        after: changes,
        reason,
      });
      return updated;
    });
    await this.invalidate(await this.repo.linkedProductSlugs(id).catch(() => []));
    return row;
  }

  async remove(
    id: string,
    reason: string,
    ifMatch: number | undefined,
    actor: Actor,
  ): Promise<void> {
    await this.deps.runInTransaction(async (tx) => {
      const current = await this.liveOrThrow(tx, id, ifMatch);
      const productCount = await this.repo.activeProductCount(tx, id);
      if (productCount > 0) {
        throw new ConflictError(
          'This disease is linked to active products; unlink them or deactivate the disease instead',
          { details: { reason: 'DISEASE_IN_USE', productCount } },
        );
      }
      await this.repo.softDelete(tx, id, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'disease.delete',
        targetType: 'disease',
        targetId: id,
        before: current,
        reason,
      });
    });
    await this.invalidate(await this.repo.linkedProductSlugs(id).catch(() => []));
  }

  /**
   * Product write: every linked id must be a live, active disease (inside the product tx).
   * `path` prefixes issue paths (`diseaseIds[2]`).
   */
  async assertLinkable(tx: Tx, ids: readonly string[], path = 'diseaseIds'): Promise<void> {
    const rows = await this.repo.findByIds(tx, ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const issues = ids.flatMap((id, i) => {
      const row = byId.get(id);
      const at = `${path}[${String(i)}]`;
      if (row === undefined) return [{ path: at, message: 'Unknown disease' }];
      if (!row.isActive) return [{ path: at, message: `"${row.name}" is inactive` }];
      return [];
    });
    if (issues.length > 0) throw new ValidationError(issues);
  }

  // ── Helpers ──

  private async chooseSlug(tx: Tx, name: string, wanted: string | undefined): Promise<string> {
    if (wanted !== undefined) {
      await this.assertSlugFree(tx, wanted);
      return wanted;
    }
    const base = slugify(name)
      .slice(0, SLUG_MAX - 4)
      .replace(/-+$/, '');
    if (base === '')
      throw new ValidationError([{ path: 'slug', message: 'Give a slug; the name has none' }]);
    return firstFreeSlug(base, await this.repo.slugsLike(tx, base));
  }

  private async assertSlugFree(tx: Tx, slug: string, exceptId?: string): Promise<void> {
    if (await this.repo.slugTaken(tx, slug, exceptId))
      throw new ConflictError(`Slug "${slug}" is already used by another disease`, {
        details: { reason: 'SLUG_TAKEN', fields: ['slug'] },
      });
  }

  private async assertNameFree(tx: Tx, name: string, exceptId?: string): Promise<void> {
    if (await this.repo.nameTaken(tx, name, exceptId))
      throw new ConflictError(`A disease named "${name}" already exists`, {
        details: { reason: 'DISEASE_DUPLICATE', fields: ['name'] },
      });
  }

  private async liveOrThrow(tx: Tx, id: string, ifMatch: number | undefined) {
    const row = await this.repo.findLive(id, tx);
    if (row === null) throw new NotFoundError('Disease');
    if (ifMatch !== undefined && ifMatch !== row.version) {
      throw new ConflictError('The disease was changed by someone else; reload and retry', {
        details: { reason: 'VERSION_CONFLICT', currentVersion: row.version },
      });
    }
    return row;
  }

  /** After commit: expire every list page + disease cards, drop linked product pages. Best effort. */
  private async invalidate(productSlugs: string[]): Promise<void> {
    try {
      await this.deps.redis.incr(productKeys.listVersion());
      if (productSlugs.length > 0)
        await this.deps.redis.del(...productSlugs.map((slug) => productKeys.product(slug)));
    } catch (err) {
      this.deps.logger.warn({ err }, 'disease cache invalidation failed');
    }
  }
}
