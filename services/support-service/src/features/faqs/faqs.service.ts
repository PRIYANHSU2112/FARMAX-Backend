import { createHash } from 'node:crypto';

import { NotFoundError, ValidationError } from '@farmx/common/errors';
import { advisoryXactLock } from '@farmx/database';
import { supportKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import type { App } from '../../middleware/http.js';
import type { Actor } from '../audit/index.js';
import type { CategoryInput, FaqCategoryView, FaqInput, FaqListQuery, FaqView } from './faqs.types.js';

type Deps = Pick<Cradle, 'faqsRepository' | 'auditService' | 'runInTransaction' | 'cache' | 'cacheGen'>;

const CONTENT_TTL = 600;

/** FAQ pages are cached per content generation (one INCR on any admin write). */
export class FaqsService {
  constructor(private readonly deps: Deps) {}

  async categories(app: App): Promise<FaqCategoryView[]> {
    return this.cached(['categories', app], () => this.deps.faqsRepository.categories(app, true));
  }

  /** Display order, or full-text ranking when `q` is given. `cursor` = next offset. */
  async list(query: FaqListQuery): Promise<{ items: FaqView[]; nextCursor: string | null; limit: number }> {
    const offset = query.cursor === undefined ? 0 : Number(query.cursor);
    const q = query.q?.trim();
    const rows = await this.cached(['list', query.app, query.categoryId ?? '', q ?? '', offset, query.limit], () =>
      q === undefined || q === ''
        ? this.deps.faqsRepository.list(query.app, query.categoryId, offset, query.limit + 1)
        : this.deps.faqsRepository.search(query.app, q, offset, query.limit + 1),
    );
    const hasMore = rows.length > query.limit;
    return {
      items: rows.slice(0, query.limit),
      nextCursor: hasMore ? String(offset + query.limit) : null,
      limit: query.limit,
    };
  }

  /** "These may answer it": text match within the topic, else the topic's most helpful FAQs. */
  async suggestions(app: App, topicCode: string, q: string | undefined): Promise<FaqView[]> {
    const text = q?.trim() ?? '';
    return this.cached(['suggest', app, topicCode, text], async () => {
      if (text.length >= 3) {
        const hits = await this.deps.faqsRepository.search(app, text, 0, 3, topicCode);
        if (hits.length > 0) return hits;
      }
      return this.deps.faqsRepository.byTopic(app, topicCode, 3);
    });
  }

  /** One vote per user; changing it moves the counters (serialised per user + FAQ). */
  async feedback(userId: string, faqId: string, helpful: boolean) {
    if (!(await this.deps.faqsRepository.isActive(faqId))) throw new NotFoundError('FAQ');
    return this.deps.runInTransaction(async (tx) => {
      await advisoryXactLock(tx, `faq-vote:${faqId}:${userId}`);
      const previous = await this.deps.faqsRepository.vote(tx, faqId, userId);
      if (previous === helpful) {
        return { faqId, helpful, changed: false };
      }
      const counts = await this.deps.faqsRepository.saveVote(tx, faqId, userId, helpful, previous);
      return { faqId, helpful, changed: true, ...counts };
    });
  }

  // ── Admin ──

  adminCategories(app?: App) {
    return this.deps.faqsRepository.categories(app, false);
  }

  adminList(app?: App, categoryId?: string) {
    return this.deps.faqsRepository.adminList(app, categoryId);
  }

  async createCategory(actor: Actor, input: CategoryInput) {
    return this.write(actor, 'faq_category.create', 'faq_category', async (tx) => {
      const row = await this.deps.faqsRepository.createCategory(tx, input);
      return { id: row.id, row };
    });
  }

  async updateCategory(actor: Actor, id: string, input: Partial<CategoryInput>) {
    return this.write(actor, 'faq_category.update', 'faq_category', async (tx) => {
      const row = await this.deps.faqsRepository.updateCategory(tx, id, input);
      if (row === null) throw new NotFoundError('FAQ category');
      return { id, row };
    });
  }

  async createFaq(actor: Actor, input: FaqInput) {
    await this.assertCategory(input.categoryId, input.app);
    return this.write(actor, 'faq.create', 'faq', async (tx) => {
      const row = await this.deps.faqsRepository.createFaq(tx, input);
      return { id: row.id, row };
    });
  }

  async updateFaq(actor: Actor, id: string, app: App | undefined, input: Partial<FaqInput>) {
    if (input.categoryId !== undefined) await this.assertCategory(input.categoryId, app);
    return this.write(actor, 'faq.update', 'faq', async (tx) => {
      const row = await this.deps.faqsRepository.updateFaq(tx, id, input);
      if (row === null) throw new NotFoundError('FAQ');
      return { id, row };
    });
  }

  async reorder(actor: Actor, app: App, ids: string[]) {
    return this.write(actor, 'faq.reorder', 'faq', async (tx) => {
      const updated = await this.deps.faqsRepository.reorder(tx, app, ids);
      return { id: app, row: { updated } };
    });
  }

  private async assertCategory(categoryId: string, app: App | undefined): Promise<void> {
    const categoryApp = await this.deps.faqsRepository.categoryApp(categoryId);
    if (categoryApp === null || (app !== undefined && categoryApp !== app))
      throw new ValidationError([{ path: 'body.categoryId', message: 'is not a category of this app' }]);
  }

  private async write<T extends object>(
    actor: Actor,
    action: string,
    targetType: 'faq' | 'faq_category',
    work: (tx: Parameters<Parameters<Cradle['runInTransaction']>[0]>[0]) => Promise<{ id: string; row: T }>,
  ): Promise<T> {
    const { row } = await this.deps.runInTransaction(async (tx) => {
      const result = await work(tx);
      await this.deps.auditService.record(tx, actor, { action, targetType, targetId: result.id, after: result.row });
      return result;
    });
    await this.deps.cacheGen.bumpContent();
    return row;
  }

  private async cached<T>(parts: (string | number)[], load: () => Promise<T>): Promise<T> {
    const gen = await this.deps.cacheGen.content();
    const hash = createHash('sha1').update(JSON.stringify(['faq', ...parts])).digest('hex').slice(0, 24);
    return this.deps.cache.getOrSet(supportKeys.content(gen, hash), CONTENT_TTL, load);
  }
}
