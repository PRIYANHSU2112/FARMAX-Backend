import { type Tx, withPrismaErrors } from '@farmx/database';

import type { Cradle } from '@fastify/awilix';

import type { App } from '../../middleware/http.js';
import { omit } from '../../middleware/http.js';
import type {
  CategoryInput,
  FaqAdminView,
  FaqCategoryView,
  FaqInput,
  FaqView,
} from './faqs.types.js';

const PUBLIC = {
  id: true,
  app: true,
  categoryId: true,
  question: true,
  answer: true,
  tags: true,
  topicCodes: true,
  sortOrder: true,
  helpfulCount: true,
  notHelpfulCount: true,
} as const;
const ADMIN = { ...PUBLIC, isActive: true, createdAt: true, updatedAt: true } as const;
const CATEGORY = {
  id: true,
  app: true,
  code: true,
  title: true,
  sortOrder: true,
  isActive: true,
} as const;

/** Only place that touches `faq_categories`, `faqs`, `faq_votes`. */
export class FaqsRepository {
  constructor(private readonly deps: Pick<Cradle, 'db'>) {}

  categories(app: App | undefined, activeOnly: boolean): Promise<FaqCategoryView[]> {
    return withPrismaErrors(() =>
      this.deps.db.faqCategory.findMany({
        where: { ...(app === undefined ? {} : { app }), ...(activeOnly ? { isActive: true } : {}) },
        orderBy: [{ app: 'asc' }, { sortOrder: 'asc' }, { title: 'asc' }],
        select: CATEGORY,
      }),
    );
  }

  /** Active FAQs of active categories, in display order (keyset on id after ordering). */
  async list(
    app: App,
    categoryId: string | undefined,
    offset: number,
    take: number,
  ): Promise<FaqView[]> {
    const activeCategoryIds = (await this.categories(app, true)).map((c) => c.id);
    return withPrismaErrors(() =>
      this.deps.db.faq.findMany({
        where: {
          app,
          isActive: true,
          categoryId: categoryId ?? { in: activeCategoryIds },
        },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        skip: offset,
        take,
        select: PUBLIC,
      }),
    );
  }

  /** Full-text search (english; question weighted over answer). */
  search(
    app: App,
    q: string,
    offset: number,
    take: number,
    topicCode?: string,
  ): Promise<FaqView[]> {
    return withPrismaErrors(
      () =>
        this.deps.db.$queryRaw<FaqView[]>`
        SELECT f."id", f."app", f."categoryId", f."question", f."answer", f."tags", f."topicCodes",
               f."sortOrder", f."helpfulCount", f."notHelpfulCount"
          FROM "faqs" f
          JOIN "faq_categories" c ON c."id" = f."categoryId" AND c."isActive"
         WHERE f."app" = ${app}::"SupportApp" AND f."isActive"
           AND (${topicCode ?? null}::text IS NULL OR ${topicCode ?? null} = ANY(f."topicCodes"))
           AND f."searchVector" @@ websearch_to_tsquery('english', ${q})
         ORDER BY ts_rank(f."searchVector", websearch_to_tsquery('english', ${q})) DESC, f."helpfulCount" DESC, f."id"
         OFFSET ${offset} LIMIT ${take}`,
    );
  }

  /** FAQs tagged for a topic, most helpful first ("These may answer it" without text). */
  byTopic(app: App, topicCode: string, take: number): Promise<FaqView[]> {
    return withPrismaErrors(() =>
      this.deps.db.faq.findMany({
        where: { app, isActive: true, topicCodes: { has: topicCode } },
        orderBy: [{ helpfulCount: 'desc' }, { sortOrder: 'asc' }],
        take,
        select: PUBLIC,
      }),
    );
  }

  async isActive(id: string): Promise<boolean> {
    return (await this.deps.db.faq.count({ where: { id, isActive: true } })) === 1;
  }

  /** Previous vote of the user (caller holds the advisory lock). */
  async vote(tx: Tx, faqId: string, userId: string): Promise<boolean | null> {
    const row = await tx.faqVote.findUnique({
      where: { faqId_userId: { faqId, userId } },
      select: { helpful: true },
    });
    return row?.helpful ?? null;
  }

  async saveVote(
    tx: Tx,
    faqId: string,
    userId: string,
    helpful: boolean,
    previous: boolean | null,
  ) {
    await tx.faqVote.upsert({
      where: { faqId_userId: { faqId, userId } },
      create: { faqId, userId, helpful },
      update: { helpful },
    });
    const inc = (yes: boolean, by: number) =>
      yes ? { helpfulCount: { increment: by } } : { notHelpfulCount: { increment: by } };
    const data = previous === null ? inc(helpful, 1) : { ...inc(previous, -1), ...inc(helpful, 1) };
    return tx.faq.update({
      where: { id: faqId },
      data,
      select: { helpfulCount: true, notHelpfulCount: true },
    });
  }

  // ── Admin ──

  adminList(app: App | undefined, categoryId: string | undefined): Promise<FaqAdminView[]> {
    return withPrismaErrors(() =>
      this.deps.db.faq.findMany({
        where: {
          ...(app === undefined ? {} : { app }),
          ...(categoryId === undefined ? {} : { categoryId }),
        },
        orderBy: [{ app: 'asc' }, { categoryId: 'asc' }, { sortOrder: 'asc' }],
        select: ADMIN,
      }),
    );
  }

  createCategory(tx: Tx, input: CategoryInput): Promise<FaqCategoryView> {
    return withPrismaErrors(() => tx.faqCategory.create({ data: input, select: CATEGORY }));
  }

  async updateCategory(
    tx: Tx,
    id: string,
    input: Partial<CategoryInput>,
  ): Promise<FaqCategoryView | null> {
    const data = omit(input, ['app', 'code']); // immutable
    const res = await withPrismaErrors(() => tx.faqCategory.updateMany({ where: { id }, data }));
    return res.count === 0 ? null : tx.faqCategory.findUnique({ where: { id }, select: CATEGORY });
  }

  async categoryApp(id: string): Promise<App | null> {
    return (
      (await this.deps.db.faqCategory.findUnique({ where: { id }, select: { app: true } }))?.app ??
      null
    );
  }

  createFaq(tx: Tx, input: FaqInput): Promise<FaqAdminView> {
    return withPrismaErrors(() => tx.faq.create({ data: input, select: ADMIN }));
  }

  async updateFaq(tx: Tx, id: string, input: Partial<FaqInput>): Promise<FaqAdminView | null> {
    const data = omit(input, ['app']); // immutable
    const res = await withPrismaErrors(() => tx.faq.updateMany({ where: { id }, data }));
    return res.count === 0 ? null : tx.faq.findUnique({ where: { id }, select: ADMIN });
  }

  /** One statement: sortOrder = position in `ids` (only rows of that app). */
  async reorder(tx: Tx, app: App, ids: readonly string[]): Promise<number> {
    return tx.$executeRaw`
      UPDATE "faqs" f SET "sortOrder" = v.pos, "updatedAt" = now()
        FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS v(id, pos)
       WHERE f."id" = v.id AND f."app" = ${app}::"SupportApp"`;
  }
}
