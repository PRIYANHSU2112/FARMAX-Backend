import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type {
  ApplicationQueueQuery,
  ApplicationRow,
  ApplyInput,
  CompanyDocInput,
  CompanyDocView,
  DocListQuery,
  PublicCompanyDoc,
  ReviewInput,
  StoredDoc,
} from './company.types.js';

const DOC = {
  id: true,
  type: true,
  title: true,
  documentNo: true,
  issuingAuthority: true,
  expiresAt: true,
  fileUrl: true,
  isPublic: true,
  createdBy: true,
  updatedBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

const PUBLIC_DOC = {
  id: true,
  type: true,
  title: true,
  documentNo: true,
  issuingAuthority: true,
  expiresAt: true,
  fileUrl: true,
  updatedAt: true,
} as const;

const APP = {
  id: true,
  applicantUserId: true,
  businessName: true,
  applicationType: true,
  attachedDocs: true,
  status: true,
  reviewNotes: true,
  reviewedBy: true,
  reviewedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const toApp = (r: Prisma.CompanyApplicationGetPayload<{ select: typeof APP }>): ApplicationRow => ({
  ...r,
  attachedDocs: r.attachedDocs as unknown as StoredDoc[],
});

/** Midnight UTC today: a document expiring today is still valid today. */
const today = (): Date => new Date(new Date().toISOString().slice(0, 10));

/** Only place that touches `company_documents` and `company_applications`. */
export class CompanyRepository {
  constructor(private readonly deps: Pick<Cradle, 'db'>) {}

  // ── documents ──

  /** Public and not expired, grouped by type. */
  publicDocs(): Promise<PublicCompanyDoc[]> {
    return withPrismaErrors(() =>
      this.deps.db.companyDocument.findMany({
        where: { isPublic: true, OR: [{ expiresAt: null }, { expiresAt: { gte: today() } }] },
        orderBy: [{ type: 'asc' }, { title: 'asc' }],
        select: PUBLIC_DOC,
      }),
    );
  }

  listDocs(query: DocListQuery): Promise<CompanyDocView[]> {
    return withPrismaErrors(() =>
      this.deps.db.companyDocument.findMany({
        where: {
          ...(query.type === undefined ? {} : { type: query.type }),
          ...(query.isPublic === undefined ? {} : { isPublic: query.isPublic }),
        },
        orderBy: [{ type: 'asc' }, { createdAt: 'desc' }],
        select: DOC,
      }),
    );
  }

  async findDoc(tx: Tx, id: string): Promise<CompanyDocView | null> {
    await tx.$queryRaw`SELECT 1 FROM "company_documents" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return tx.companyDocument.findUnique({ where: { id }, select: DOC });
  }

  createDoc(tx: Tx, input: CompanyDocInput, userId: string): Promise<CompanyDocView> {
    return withPrismaErrors(() =>
      tx.companyDocument.create({
        data: {
          type: input.type,
          title: input.title,
          documentNo: input.documentNo,
          issuingAuthority: input.issuingAuthority,
          expiresAt: input.expiresAt ?? null,
          fileUrl: input.fileUrl,
          isPublic: input.isPublic ?? false,
          createdBy: userId,
        },
        select: DOC,
      }),
    );
  }

  updateDoc(
    tx: Tx,
    id: string,
    input: Partial<CompanyDocInput>,
    userId: string,
  ): Promise<CompanyDocView> {
    return withPrismaErrors(() =>
      tx.companyDocument.update({
        where: { id },
        data: {
          ...(input.type === undefined ? {} : { type: input.type }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.documentNo === undefined ? {} : { documentNo: input.documentNo }),
          ...(input.issuingAuthority === undefined
            ? {}
            : { issuingAuthority: input.issuingAuthority }),
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
          ...(input.fileUrl === undefined ? {} : { fileUrl: input.fileUrl }),
          ...(input.isPublic === undefined ? {} : { isPublic: input.isPublic }),
          updatedBy: userId,
        },
        select: DOC,
      }),
    );
  }

  async deleteDoc(tx: Tx, id: string): Promise<void> {
    await withPrismaErrors(() => tx.companyDocument.delete({ where: { id } }));
  }

  // ── applications ──

  /** Throws the raw Prisma error on the one-open-per-type index (the service maps it). */
  async createApplication(
    tx: Tx,
    applicantUserId: string,
    input: Omit<ApplyInput, 'attachments'>,
    docs: StoredDoc[],
  ): Promise<ApplicationRow> {
    return toApp(
      await tx.companyApplication.create({
        data: {
          applicantUserId,
          businessName: input.businessName,
          applicationType: input.applicationType,
          attachedDocs: docs as unknown as Prisma.InputJsonValue,
        },
        select: APP,
      }),
    );
  }

  async applicationsOf(applicantUserId: string): Promise<ApplicationRow[]> {
    const rows = await withPrismaErrors(() =>
      this.deps.db.companyApplication.findMany({
        where: { applicantUserId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: APP,
      }),
    );
    return rows.map(toApp);
  }

  /** Review queue: oldest first (first come, first reviewed); cursor = last id seen. */
  async queue(query: ApplicationQueueQuery, take: number): Promise<ApplicationRow[]> {
    const rows = await withPrismaErrors(() =>
      this.deps.db.companyApplication.findMany({
        where: {
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.type === undefined ? {} : { applicationType: query.type }),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
        take,
        select: APP,
      }),
    );
    return rows.map(toApp);
  }

  async findApplication(id: string): Promise<ApplicationRow | null> {
    const row = await withPrismaErrors(() =>
      this.deps.db.companyApplication.findUnique({ where: { id }, select: APP }),
    );
    return row === null ? null : toApp(row);
  }

  async lockApplication(tx: Tx, id: string): Promise<ApplicationRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "company_applications" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const row = await tx.companyApplication.findUnique({ where: { id }, select: APP });
    return row === null ? null : toApp(row);
  }

  async review(
    tx: Tx,
    id: string,
    input: ReviewInput,
    reviewerId: string,
  ): Promise<ApplicationRow> {
    return toApp(
      await tx.companyApplication.update({
        where: { id },
        data: {
          status: input.status,
          reviewNotes: input.reviewNotes ?? null,
          reviewedBy: reviewerId,
          reviewedAt: new Date(),
        },
        select: APP,
      }),
    );
  }

  /** Private file keys of a user's applications (account deletion). */
  async attachmentKeysOf(applicantUserId: string): Promise<string[]> {
    const rows = await this.deps.db.companyApplication.findMany({
      where: { applicantUserId },
      select: { attachedDocs: true },
    });
    return rows.flatMap((r) => (r.attachedDocs as unknown as StoredDoc[]).map((d) => d.key));
  }

  async deleteApplicationsOf(tx: Tx, applicantUserId: string): Promise<number> {
    const { count } = await tx.companyApplication.deleteMany({ where: { applicantUserId } });
    return count;
  }
}
