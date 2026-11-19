import { type Tx, withPrismaErrors } from '@farmx/database';
import type { GstVerification, KycDocument } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { GstRecord } from '../../adapters/kyc-providers.js';
import type { DocumentInput, KycDocumentView } from './kyc.types.js';

const toDoc = (row: KycDocument): KycDocumentView => ({
  id: row.id,
  farmId: row.farmId,
  docType: row.docType,
  contentType: row.contentType,
  sizeBytes: row.sizeBytes,
  status: row.status,
  rejectionCode: row.rejectionCode,
  rejectionNote: row.rejectionNote,
  reviewedAt: row.reviewedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/** Only place that queries `kyc_documents` and `gst_verifications`. Never selects storage keys into views. */
export class KycRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** Supersedes the owner's previous live document of the same type, then inserts the new one. */
  async addDocument(
    tx: Tx,
    ownerId: string,
    farmId: string,
    uploadedByUserId: string,
    input: DocumentInput,
  ): Promise<KycDocumentView> {
    await tx.kycDocument.updateMany({
      where: { ownerId, docType: input.docType, status: { in: ['UPLOADED', 'REJECTED'] } },
      data: { status: 'SUPERSEDED' },
    });
    return toDoc(
      await tx.kycDocument.create({ data: { ownerId, farmId, uploadedByUserId, ...input } }),
    );
  }

  /** Current (non-superseded) documents of an owner — index (ownerId, docType, createdAt). */
  async listCurrent(ownerId: string, tx?: Tx): Promise<KycDocumentView[]> {
    const rows = await withPrismaErrors(() =>
      (tx ?? this.db).kycDocument.findMany({
        where: { ownerId, status: { not: 'SUPERSEDED' } },
        orderBy: { id: 'desc' },
        take: 50,
      }),
    );
    return rows.map(toDoc);
  }

  async findDocument(id: string, ownerId: string): Promise<KycDocumentView | null> {
    const row = await withPrismaErrors(() =>
      this.db.kycDocument.findFirst({ where: { id, ownerId } }),
    );
    return row === null ? null : toDoc(row);
  }

  /** Decides only a still-UPLOADED document (no double decisions). */
  async decide(
    tx: Tx,
    id: string,
    data: {
      status: 'ACCEPTED' | 'REJECTED';
      rejectionCode: string | null;
      rejectionNote: string | null;
      reviewedByUserId: string;
    },
  ): Promise<boolean> {
    const { count } = await tx.kycDocument.updateMany({
      where: { id, status: 'UPLOADED' },
      data: { ...data, reviewedAt: new Date() },
    });
    return count === 1;
  }

  async addGstVerification(
    record: GstRecord,
    provider: string,
    requestedBy: string,
  ): Promise<GstVerification> {
    return withPrismaErrors(() =>
      this.db.gstVerification.create({
        data: {
          gstin: record.gstin,
          legalName: record.legalName,
          tradeName: record.tradeName,
          portalStatus: record.status,
          stateCode: record.stateCode,
          provider,
          requestedBy,
        },
      }),
    );
  }

  findGstVerification(id: string): Promise<GstVerification | null> {
    return withPrismaErrors(() => this.db.gstVerification.findUnique({ where: { id } }));
  }
}
