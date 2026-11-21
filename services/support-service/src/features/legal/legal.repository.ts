import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { App } from '../../middleware/http.js';
import type { LegalDraftInput, LegalKind, LegalSection, LegalView } from './legal.types.js';

const VIEW = {
  id: true, kind: true, app: true, version: true, title: true, intro: true, sections: true, status: true,
  effectiveFrom: true, publishedAt: true, publishedBy: true, updatedAt: true,
} as const;

const toView = (r: Prisma.LegalDocumentGetPayload<{ select: typeof VIEW }>): LegalView => ({
  ...r,
  sections: r.sections as unknown as LegalSection[],
});

/** Only place that touches `legal_documents`. */
export class LegalRepository {
  constructor(private readonly deps: Pick<Cradle, 'db'>) {}

  /** The published version for the app, else the one for every app. */
  async published(kind: LegalKind, app: App): Promise<LegalView | null> {
    const rows = await withPrismaErrors(() =>
      this.deps.db.legalDocument.findMany({
        where: { kind, status: 'PUBLISHED', OR: [{ app }, { app: null }] },
        select: VIEW,
      }),
    );
    const row = rows.find((r) => r.app === app) ?? rows.find((r) => r.app === null);
    return row === undefined ? null : toView(row);
  }

  async list(kind?: LegalKind, app?: App | null): Promise<LegalView[]> {
    const rows = await withPrismaErrors(() =>
      this.deps.db.legalDocument.findMany({
        where: { ...(kind === undefined ? {} : { kind }), ...(app === undefined ? {} : { app }) },
        orderBy: [{ kind: 'asc' }, { app: 'asc' }, { version: 'desc' }],
        select: VIEW,
      }),
    );
    return rows.map(toView);
  }

  async find(tx: Tx, id: string): Promise<LegalView | null> {
    await tx.$queryRaw`SELECT 1 FROM "legal_documents" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const row = await tx.legalDocument.findUnique({ where: { id }, select: VIEW });
    return row === null ? null : toView(row);
  }

  async nextVersion(tx: Tx, kind: LegalKind, app: App | null): Promise<number> {
    const agg = await tx.legalDocument.aggregate({ where: { kind, app }, _max: { version: true } });
    return (agg._max.version ?? 0) + 1;
  }

  async create(tx: Tx, input: LegalDraftInput, version: number, createdBy: string): Promise<LegalView> {
    return toView(
      await withPrismaErrors(() =>
        tx.legalDocument.create({
          data: {
            kind: input.kind,
            app: input.app ?? null,
            version,
            title: input.title,
            intro: input.intro ?? null,
            sections: input.sections as unknown as Prisma.InputJsonValue,
            effectiveFrom: input.effectiveFrom ?? null,
            createdBy,
          },
          select: VIEW,
        }),
      ),
    );
  }

  async updateDraft(tx: Tx, id: string, input: Partial<LegalDraftInput>): Promise<LegalView> {
    return toView(
      await tx.legalDocument.update({
        where: { id },
        data: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.intro === undefined ? {} : { intro: input.intro }),
          ...(input.sections === undefined ? {} : { sections: input.sections as unknown as Prisma.InputJsonValue }),
          ...(input.effectiveFrom === undefined ? {} : { effectiveFrom: input.effectiveFrom }),
        },
        select: VIEW,
      }),
    );
  }

  /** Archives the current published version of (kind, app) and publishes `id` (one tx). */
  async publish(tx: Tx, doc: LegalView, userId: string): Promise<LegalView> {
    await tx.legalDocument.updateMany({
      where: { kind: doc.kind, app: doc.app, status: 'PUBLISHED' },
      data: { status: 'ARCHIVED' },
    });
    return toView(
      await tx.legalDocument.update({
        where: { id: doc.id },
        data: { status: 'PUBLISHED', publishedAt: new Date(), publishedBy: userId },
        select: VIEW,
      }),
    );
  }
}
