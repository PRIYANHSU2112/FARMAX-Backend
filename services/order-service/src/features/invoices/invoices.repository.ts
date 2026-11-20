import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type {
  AlreadyInvoiced,
  DraftLine,
  IssuedDocument,
  TaxDocumentType,
} from './invoices.types.js';

export interface NewTaxDocument {
  id: string;
  docType: TaxDocumentType;
  docNo: string;
  series: string;
  fy: string;
  orderId: string;
  orderNo: string;
  shipmentId: string | null;
  originalDocId: string | null;
  userId: string;
  farmId: string;
  sellerGstin: string;
  sellerStateCode: string;
  buyerGstin: string | null;
  placeOfSupply: string;
  supplyType: 'INTRA' | 'INTER';
  gstr1Section: string;
  taxablePaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
  totalTaxPaise: bigint;
  roundOffPaise: bigint;
  grandTotalPaise: bigint;
  amountInWords: string;
  snapshot: object;
  snapshotSha256: string;
  idempotencyKey: string;
  reason: string | null;
  issuedAt: Date;
  issuedBy: string | null;
}

const issuedSelect = {
  id: true,
  docType: true,
  docNo: true,
  orderId: true,
  shipmentId: true,
  grandTotalPaise: true,
  issuedAt: true,
} as const;

/** Only place that touches tax_documents, tax_document_lines and invoice_sequences. */
export class InvoicesRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  async findByKey(
    tx: Tx,
    idempotencyKey: string,
  ): Promise<Omit<IssuedDocument, 'replayed'> | null> {
    return tx.taxDocument.findUnique({ where: { idempotencyKey }, select: issuedSelect });
  }

  /** Units already billed per order line (invoices + bills of supply) and whether freight was. */
  async invoiced(tx: Tx, orderId: string): Promise<AlreadyInvoiced> {
    const rows = await tx.$queryRaw<{ orderLineNo: number | null; kind: string; qty: bigint }[]>`
      SELECT l."orderLineNo", l."kind", sum(l."qty")::bigint AS "qty"
      FROM "tax_document_lines" l
      JOIN "tax_documents" d ON d."id" = l."documentId"
      WHERE l."orderId" = ${orderId}::uuid AND d."docType" IN ('TAX_INVOICE', 'BILL_OF_SUPPLY')
      GROUP BY l."orderLineNo", l."kind"`;
    const qtyByLine = new Map<number, number>();
    let freightInvoiced = false;
    for (const r of rows) {
      if (r.kind === 'FREIGHT') freightInvoiced = true;
      else if (r.orderLineNo !== null) qtyByLine.set(r.orderLineNo, Number(r.qty));
    }
    return { qtyByLine, freightInvoiced };
  }

  /**
   * Next number of a (GSTIN, series, financial year): one atomic upsert that row-locks the
   * counter until the issuing transaction ends. A rollback returns the number → gapless.
   */
  async nextNumber(tx: Tx, sellerGstin: string, series: string, fy: string): Promise<number> {
    const rows = await tx.$queryRaw<{ last: number }[]>`
      INSERT INTO "invoice_sequences" ("sellerGstin", "series", "fy", "last")
      VALUES (${sellerGstin}, ${series}, ${fy}, 1)
      ON CONFLICT ("sellerGstin", "series", "fy")
      DO UPDATE SET "last" = "invoice_sequences"."last" + 1
      RETURNING "last"`;
    const next = rows[0]?.last;
    if (next === undefined) throw new Error('invoice sequence returned no row');
    return next;
  }

  async insert(tx: Tx, doc: NewTaxDocument, lines: readonly DraftLine[]): Promise<void> {
    await withPrismaErrors(async () => {
      await tx.taxDocument.create({
        data: { ...doc, snapshot: doc.snapshot },
        select: { id: true },
      });
      await tx.taxDocumentLine.createMany({
        data: lines.map((l) => ({ ...l, documentId: doc.id, orderId: doc.orderId })),
      });
    });
  }

  // ── PDF rendering (only pdf* / updatedAt change: allowed by the immutability trigger) ──

  /**
   * Claims up to `limit` documents to render, atomically and replica-safe (SKIP LOCKED):
   * PENDING, FAILED whose backoff (30 s × 2^attempts, ≤ 1 h) has passed and attempts remain, and
   * RENDERING claims older than `staleMs` (a crashed renderer). Each claim counts one attempt.
   */
  async claimForRender(limit: number, maxAttempts: number, staleMs: number): Promise<RenderJob[]> {
    return withPrismaErrors(
      () => this.db.$queryRaw<RenderJob[]>`
        UPDATE "tax_documents"
        SET "pdfStatus" = 'RENDERING', "pdfAttempts" = "pdfAttempts" + 1, "updatedAt" = now()
        WHERE "id" IN (
          SELECT "id" FROM "tax_documents"
          WHERE "pdfStatus" = 'PENDING'
             OR ("pdfStatus" = 'FAILED' AND "pdfAttempts" < ${maxAttempts}
                 AND "updatedAt" < now() - make_interval(secs => least(3600, 30 * power(2, "pdfAttempts"))))
             OR ("pdfStatus" = 'RENDERING' AND "updatedAt" < ${new Date(Date.now() - staleMs)})
          ORDER BY "updatedAt"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING "id", "docNo", "fy", "snapshot", "pdfAttempts"`,
    );
  }

  /** RENDERING → READY (a stale renderer that lost its claim cannot overwrite a newer one). */
  async markRendered(id: string, attempt: number, key: string, sha256: string): Promise<boolean> {
    const { count } = await withPrismaErrors(() =>
      this.db.taxDocument.updateMany({
        where: { id, pdfStatus: 'RENDERING', pdfAttempts: attempt },
        data: {
          pdfStatus: 'READY',
          pdfKey: key,
          pdfSha256: sha256,
          pdfError: null,
          pdfRenderedAt: new Date(),
        },
      }),
    );
    return count === 1;
  }

  async markRenderFailed(id: string, attempt: number, error: string): Promise<void> {
    await withPrismaErrors(() =>
      this.db.taxDocument.updateMany({
        where: { id, pdfStatus: 'RENDERING', pdfAttempts: attempt },
        data: { pdfStatus: 'FAILED', pdfError: error.slice(0, 300) },
      }),
    );
  }
}

export interface RenderJob {
  id: string;
  docNo: string;
  fy: string;
  snapshot: unknown;
  pdfAttempts: number;
}
