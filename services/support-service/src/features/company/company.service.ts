import { createHash } from 'node:crypto';

import { ConflictError, NotFoundError } from '@farmx/common/errors';
import { isUniqueViolation } from '@farmx/database';
import { SUPPORT_EVENTS } from '@farmx/infra/events';
import { supportKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import { emitSupportEvent } from '../../adapters/events.js';
import type { UserContact } from '../../adapters/upstreams.js';
import { omit } from '../../middleware/http.js';
import type { Actor } from '../audit/index.js';
import { assertReviewable } from './company.rules.js';
import type {
  ApplicationQueueQuery,
  ApplicationRow,
  ApplicationSummary,
  ApplicationView,
  ApplyInput,
  CompanyDocInput,
  CompanyDocView,
  DocListQuery,
  MyApplicationView,
  PublicCompanyDoc,
  ReviewInput,
} from './company.types.js';

type Deps = Pick<
  Cradle,
  | 'companyRepository'
  | 'auditService'
  | 'runInTransaction'
  | 'cache'
  | 'cacheGen'
  | 'mediaClient'
  | 'authDirectory'
>;

/** Company licences / certificates (public, cached) and dealer / partner applications. */
export class CompanyService {
  constructor(private readonly deps: Deps) {}

  // ── documents ──

  /** Public, unexpired certificates. Cached per content generation (any doc write bumps it). */
  async publicDocs(): Promise<{ docs: PublicCompanyDoc[]; etag: string }> {
    const gen = await this.deps.cacheGen.content();
    const docs = await this.deps.cache.getOrSet(
      supportKeys.content(gen, 'company.documents'),
      600,
      () => this.deps.companyRepository.publicDocs(),
    );
    const hash = createHash('sha1').update(JSON.stringify(docs)).digest('base64url').slice(0, 16);
    return { docs, etag: `"${hash}"` };
  }

  listDocs(query: DocListQuery): Promise<CompanyDocView[]> {
    return this.deps.companyRepository.listDocs(query);
  }

  async createDoc(actor: Actor, input: CompanyDocInput): Promise<CompanyDocView> {
    const doc = await this.deps.runInTransaction(async (tx) => {
      const created = await this.deps.companyRepository.createDoc(tx, input, actor.userId ?? '');
      await this.deps.auditService.record(tx, actor, {
        action: 'company.doc.create',
        targetType: 'company_document',
        targetId: created.id,
        after: { type: created.type, documentNo: created.documentNo, isPublic: created.isPublic },
      });
      return created;
    });
    await this.deps.cacheGen.bumpContent();
    return doc;
  }

  async updateDoc(
    actor: Actor,
    id: string,
    input: Partial<CompanyDocInput>,
  ): Promise<CompanyDocView> {
    const doc = await this.deps.runInTransaction(async (tx) => {
      const before = await this.deps.companyRepository.findDoc(tx, id);
      if (before === null) throw new NotFoundError('Document');
      const updated = await this.deps.companyRepository.updateDoc(
        tx,
        id,
        input,
        actor.userId ?? '',
      );
      await this.deps.auditService.record(tx, actor, {
        action: 'company.doc.update',
        targetType: 'company_document',
        targetId: id,
        before: pick(before, Object.keys(input)),
        after: input,
      });
      return updated;
    });
    await this.deps.cacheGen.bumpContent();
    return doc;
  }

  async deleteDoc(actor: Actor, id: string, reason: string): Promise<void> {
    await this.deps.runInTransaction(async (tx) => {
      const before = await this.deps.companyRepository.findDoc(tx, id);
      if (before === null) throw new NotFoundError('Document');
      await this.deps.companyRepository.deleteDoc(tx, id);
      await this.deps.auditService.record(tx, actor, {
        action: 'company.doc.delete',
        targetType: 'company_document',
        targetId: id,
        before: { type: before.type, title: before.title, documentNo: before.documentNo },
        reason,
      });
    });
    await this.deps.cacheGen.bumpContent();
  }

  // ── applications (applicant) ──

  /** Receipts are verified locally BEFORE the transaction; one open application per type. */
  async apply(userId: string, input: ApplyInput): Promise<MyApplicationView> {
    const docs = this.deps.mediaClient
      .verifyReceipts(input.attachments, userId)
      .map((u) => ({ key: u.key, fileName: u.fileName, mime: u.mime, size: u.size }));
    let row: ApplicationRow;
    try {
      row = await this.deps.runInTransaction((tx) =>
        this.deps.companyRepository.createApplication(tx, userId, input, docs),
      );
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictError(
          `You already have a ${input.applicationType.toLowerCase()} application under review`,
        );
      throw err;
    }
    return mine(toView(row, await this.sign([row])));
  }

  async mine(userId: string): Promise<MyApplicationView[]> {
    const rows = await this.deps.companyRepository.applicationsOf(userId);
    const urls = await this.sign(rows);
    return rows.map((r) => mine(toView(r, urls)));
  }

  // ── applications (staff) ──

  async queue(query: ApplicationQueueQuery) {
    const rows = await this.deps.companyRepository.queue(query, query.limit + 1);
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(summary),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
      limit: query.limit,
    };
  }

  /** Signed file URLs + the applicant's name / phone (null when auth-service is unreachable). */
  async detail(id: string): Promise<ApplicationView & { applicant: UserContact | null }> {
    const row = await this.deps.companyRepository.findApplication(id);
    if (row === null) throw new NotFoundError('Application');
    const [urls, applicant] = await Promise.all([
      this.sign([row]),
      this.deps.authDirectory.contact(row.applicantUserId).catch(() => null),
    ]);
    return { ...toView(row, urls), applicant };
  }

  /** SUBMITTED → APPROVED | REJECTED; audit + outbox event in the same transaction. */
  async review(actor: Actor, id: string, input: ReviewInput): Promise<ApplicationView> {
    const reviewerId = actor.userId ?? '';
    const row = await this.deps.runInTransaction(async (tx) => {
      const current = await this.deps.companyRepository.lockApplication(tx, id);
      if (current === null) throw new NotFoundError('Application');
      assertReviewable(current, reviewerId, input);
      const updated = await this.deps.companyRepository.review(tx, id, input, reviewerId);
      await this.deps.auditService.record(tx, actor, {
        action:
          input.status === 'APPROVED'
            ? 'company.application.approve'
            : 'company.application.reject',
        targetType: 'company_application',
        targetId: id,
        before: { status: current.status },
        after: { status: updated.status },
        reason: input.reviewNotes ?? null,
      });
      await emitSupportEvent(
        tx,
        SUPPORT_EVENTS.applicationStatusChanged,
        {
          applicationId: id,
          applicationType: updated.applicationType,
          applicantUserId: updated.applicantUserId,
          from: current.status,
          to: updated.status,
          actorId: reviewerId,
        },
        actor.requestId ?? id,
      );
      return updated;
    });
    return toView(row, await this.sign([row]));
  }

  /** 5-minute signed URLs for every attachment of the rows (one media-service call). */
  private sign(rows: ApplicationRow[]): Promise<Record<string, string>> {
    return this.deps.mediaClient.signRead(rows.flatMap((r) => r.attachedDocs.map((d) => d.key)));
  }
}

/** Swaps private keys for signed URLs (null when the file is gone). */
const toView = (row: ApplicationRow, urls: Record<string, string>): ApplicationView => ({
  ...row,
  attachedDocs: row.attachedDocs.map((d) => ({
    fileName: d.fileName,
    mime: d.mime,
    size: d.size,
    url: urls[d.key] ?? null,
  })),
});

const mine = (view: ApplicationView): MyApplicationView => omit(view, ['reviewedBy']);

const summary = ({ attachedDocs, ...rest }: ApplicationRow): ApplicationSummary => ({
  ...rest,
  attachmentCount: attachedDocs.length,
});

const pick = (obj: object, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => keys.includes(k)));
