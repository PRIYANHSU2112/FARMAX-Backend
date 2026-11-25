import type { Paginated } from '@farmx/common/types';
import { type Tx, cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type {
  ActiveInvoice,
  AlreadyInvoiced,
  DownloadTarget,
  DraftLine,
  InvoiceSearch,
  IssuedDocument,
  TaxDocumentSummary,
  TaxDocumentType,
} from './invoices.types.js';

const LINE_SELECT = {
  lineNo: true,
  kind: true,
  orderLineNo: true,
  variantId: true,
  sku: true,
  description: true,
  hsnSac: true,
  qty: true,
  unitPricePaise: true,
  grossPaise: true,
  discountPaise: true,
  taxablePaise: true,
  gstRateBp: true,
  cgstPaise: true,
  sgstPaise: true,
  igstPaise: true,
  totalPaise: true,
} as const;

const SUMMARY_SELECT = {
  id: true,
  docType: true,
  docNo: true,
  status: true,
  orderId: true,
  orderNo: true,
  shipmentId: true,
  originalDocId: true,
  buyerGstin: true,
  placeOfSupply: true,
  supplyType: true,
  gstr1Section: true,
  taxablePaise: true,
  totalTaxPaise: true,
  grandTotalPaise: true,
  pdfStatus: true,
  issuedAt: true,
} as const;

const DOWNLOAD_SELECT = {
  id: true,
  docNo: true,
  fy: true,
  pdfStatus: true,
  pdfKey: true,
  pdfSha256: true,
  snapshot: true,
  snapshotSha256: true,
} as const;

/** A document id is generated in the issuing transaction, milliseconds from `issuedAt`. */
const ID_SLACK_MS = 60_000;

/** Smallest UUID v7 of a millisecond: lets a date range ride the primary-key index. */
export const uuidv7Floor = (at: Date): string => {
  const hex = Math.max(0, at.getTime()).toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
};

/** Exact issuedAt bounds plus id bounds (index-assisted) for an optional date range. */
const rangeWhere = (from?: string, to?: string): Prisma.TaxDocumentWhereInput => {
  if (from === undefined && to === undefined) return {};
  const start = from === undefined ? undefined : istDayStart(from);
  const end = to === undefined ? undefined : new Date(istDayStart(to).getTime() + 86_400_000);
  return {
    issuedAt: {
      ...(start === undefined ? {} : { gte: start }),
      ...(end === undefined ? {} : { lt: end }),
    },
    id: {
      ...(start === undefined ? {} : { gte: uuidv7Floor(new Date(start.getTime() - ID_SLACK_MS)) }),
      ...(end === undefined ? {} : { lt: uuidv7Floor(new Date(end.getTime() + ID_SLACK_MS)) }),
    },
  };
};

/** 00:00 IST of a YYYY-MM-DD day as an instant. */
export const istDayStart = (day: string): Date => new Date(`${day}T00:00:00+05:30`);

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

  /**
   * Units already billed per order line (invoices + bills of supply) and whether freight was.
   * A VOIDED invoice (fully reversed by a `cn:void:` credit note because its goods never left or
   * came back) no longer counts: its units can be billed again by the replacement invoice.
   * Units credited for a shortage stay counted (they were refunded, never billed again).
   */
  async invoiced(tx: Tx, orderId: string): Promise<AlreadyInvoiced> {
    const rows = await tx.$queryRaw<{ orderLineNo: number | null; kind: string; qty: bigint }[]>`
      SELECT l."orderLineNo", l."kind", sum(l."qty")::bigint AS "qty"
      FROM "tax_document_lines" l
      JOIN "tax_documents" d ON d."id" = l."documentId"
      WHERE l."orderId" = ${orderId}::uuid AND d."docType" IN ('TAX_INVOICE', 'BILL_OF_SUPPLY')
        AND NOT EXISTS (
          SELECT 1 FROM "tax_documents" c
          WHERE c."originalDocId" = d."id" AND c."idempotencyKey" LIKE 'cn:void:%')
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

  /**
   * The active (not voided) invoice of a shipment, its lines and the units already credited per
   * invoice line — read inside the caller's transaction (the order row is locked by the caller).
   */
  async activeInvoice(tx: Tx, orderId: string, shipmentId: string): Promise<ActiveInvoice | null> {
    const [doc] = await tx.$queryRaw<
      (Omit<ActiveInvoice, 'lines' | 'creditedQty' | 'linesHash' | 'creditNotes'> & {
        idempotencyKey: string;
      })[]
    >`
      SELECT d."id", d."docType"::text AS "docType", d."docNo", d."fy", d."status"::text AS "status",
        d."orderId", d."orderNo", d."shipmentId", d."userId", d."farmId", d."sellerGstin",
        d."sellerStateCode", d."buyerGstin", d."placeOfSupply", d."supplyType"::text AS "supplyType",
        d."issuedAt", d."snapshot", d."idempotencyKey"
      FROM "tax_documents" d
      WHERE d."orderId" = ${orderId}::uuid AND d."shipmentId" = ${shipmentId}::uuid
        AND d."docType" IN ('TAX_INVOICE', 'BILL_OF_SUPPLY')
        AND NOT EXISTS (
          SELECT 1 FROM "tax_documents" c
          WHERE c."originalDocId" = d."id" AND c."idempotencyKey" LIKE 'cn:void:%')
      ORDER BY d."issuedAt" DESC
      LIMIT 1`;
    if (doc === undefined) return null;
    const [lines, credited] = await Promise.all([
      tx.taxDocumentLine.findMany({
        where: { documentId: doc.id },
        orderBy: { lineNo: 'asc' },
        select: LINE_SELECT,
      }),
      tx.$queryRaw<{ orderLineNo: number | null; kind: string; qty: bigint; notes: bigint }[]>`
        SELECT l."orderLineNo", l."kind", sum(l."qty")::bigint AS "qty",
          count(DISTINCT c."id")::bigint AS "notes"
        FROM "tax_documents" c
        JOIN "tax_document_lines" l ON l."documentId" = c."id"
        WHERE c."originalDocId" = ${doc.id}::uuid AND c."docType" = 'CREDIT_NOTE'
        GROUP BY l."orderLineNo", l."kind"`,
    ]);
    const creditedQty = new Map<number, number>();
    for (const c of credited) {
      const inv = lines.find((l) =>
        c.kind === 'FREIGHT' ? l.kind === 'FREIGHT' : l.orderLineNo === c.orderLineNo,
      );
      if (inv !== undefined) creditedQty.set(inv.lineNo, Number(c.qty));
    }
    const { idempotencyKey, ...rest } = doc;
    return {
      ...rest,
      linesHash: idempotencyKey.split(':')[2] ?? '',
      lines: lines as ActiveInvoice['lines'],
      creditedQty,
      creditNotes: credited.reduce((n, c) => Math.max(n, Number(c.notes)), 0),
    };
  }

  /** Invoices ever issued for a shipment (voided ones included): the next key generation. */
  countForShipment(tx: Tx, shipmentId: string): Promise<number> {
    return withPrismaErrors(() =>
      tx.taxDocument.count({
        where: { shipmentId, docType: { in: ['TAX_INVOICE', 'BILL_OF_SUPPLY'] } },
      }),
    );
  }

  /** Id of the active invoice of a shipment (warehouse print), outside any transaction. */
  async activeInvoiceId(orderId: string, shipmentId: string): Promise<string | null> {
    const [row] = await withPrismaErrors(
      () => this.db.$queryRaw<{ id: string }[]>`
        SELECT d."id" FROM "tax_documents" d
        WHERE d."orderId" = ${orderId}::uuid AND d."shipmentId" = ${shipmentId}::uuid
          AND d."docType" IN ('TAX_INVOICE', 'BILL_OF_SUPPLY')
          AND NOT EXISTS (
            SELECT 1 FROM "tax_documents" c
            WHERE c."originalDocId" = d."id" AND c."idempotencyKey" LIKE 'cn:void:%')
        ORDER BY d."issuedAt" DESC
        LIMIT 1`,
    );
    return row?.id ?? null;
  }

  /** Active invoices issued since `since` (index on issuedAt / id; bounded). */
  recentActiveShipments(since: Date, limit: number) {
    return withPrismaErrors(
      () => this.db.$queryRaw<{ orderId: string; shipmentId: string }[]>`
        SELECT d."orderId", d."shipmentId" FROM "tax_documents" d
        WHERE d."issuedAt" >= ${since} AND d."id" >= ${uuidv7Floor(new Date(since.getTime() - ID_SLACK_MS))}::uuid
          AND d."docType" IN ('TAX_INVOICE', 'BILL_OF_SUPPLY') AND d."status" <> 'CREDITED'
          AND d."shipmentId" IS NOT NULL
        ORDER BY d."id" DESC
        LIMIT ${limit}`,
    );
  }

  /** Credit status only moves forward (also enforced by the DB trigger). */
  async setStatus(tx: Tx, id: string, status: 'PARTIALLY_CREDITED' | 'CREDITED'): Promise<void> {
    await withPrismaErrors(() =>
      tx.taxDocument.update({ where: { id }, data: { status }, select: { id: true } }),
    );
  }

  // ── Reads (no snapshot JSON in lists: rows stay small and fast) ──

  /** One buyer's documents of one order, oldest first (another buyer's order → empty list). */
  listForOrder(orderId: string, userId: string): Promise<TaxDocumentSummary[]> {
    return withPrismaErrors(() =>
      this.db.taxDocument.findMany({
        where: { orderId, userId },
        orderBy: { issuedAt: 'asc' },
        select: SUMMARY_SELECT,
        take: 100,
      }),
    );
  }

  /** What a download needs; `owner` narrows to one buyer (another buyer's document → null). */
  downloadTarget(
    id: string,
    owner?: { orderId: string; userId: string },
  ): Promise<DownloadTarget | null> {
    return withPrismaErrors(() =>
      this.db.taxDocument.findFirst({
        where: { id, ...(owner ?? {}) },
        select: DOWNLOAD_SELECT,
      }),
    );
  }

  /** Every document of one buyer's order for the combined PDF (bounded). */
  /** The identity of an order's document set (ids + snapshot hashes; no JSON): the cache key. */
  docKeysForOrder(
    orderId: string,
    userId: string,
    limit: number,
  ): Promise<{ id: string; snapshotSha256: string }[]> {
    return withPrismaErrors(() =>
      this.db.taxDocument.findMany({
        where: { orderId, userId },
        orderBy: { issuedAt: 'asc' },
        select: { id: true, snapshotSha256: true },
        take: limit,
      }),
    );
  }

  snapshotsForOrder(orderId: string, userId: string, limit: number): Promise<DownloadTarget[]> {
    return withPrismaErrors(() =>
      this.db.taxDocument.findMany({
        where: { orderId, userId },
        orderBy: { issuedAt: 'asc' },
        select: DOWNLOAD_SELECT,
        take: limit,
      }),
    );
  }

  /** Admin register: keyset on id DESC (UUID v7 = issue order); date range as id bounds too. */
  async search(f: InvoiceSearch): Promise<Paginated<TaxDocumentSummary>> {
    const where: Prisma.TaxDocumentWhereInput = {
      ...(f.q === undefined ? {} : { OR: [{ docNo: f.q }, { orderNo: f.q }] }),
      ...(f.orderId === undefined ? {} : { orderId: f.orderId }),
      ...(f.userId === undefined ? {} : { userId: f.userId }),
      ...(f.farmId === undefined ? {} : { farmId: f.farmId }),
      ...(f.docType === undefined ? {} : { docType: f.docType }),
      ...(f.status === undefined ? {} : { status: f.status }),
      ...(f.pdfStatus === undefined ? {} : { pdfStatus: f.pdfStatus }),
      ...(f.b2b === undefined ? {} : { buyerGstin: f.b2b ? { not: null } : null }),
      ...rangeWhere(f.from, f.to),
    };
    const rows = await withPrismaErrors(() =>
      this.db.taxDocument.findMany({
        where,
        orderBy: { id: 'desc' },
        select: SUMMARY_SELECT,
        ...cursorArgs(f),
      }),
    );
    return toPage(rows as TaxDocumentSummary[], f.limit);
  }

  /** Admin detail: the document, its lines and the documents linked to it. */
  async detail(id: string) {
    const doc = await withPrismaErrors(() =>
      this.db.taxDocument.findUnique({
        where: { id },
        select: {
          ...SUMMARY_SELECT,
          fy: true,
          series: true,
          userId: true,
          farmId: true,
          sellerGstin: true,
          sellerStateCode: true,
          reverseCharge: true,
          cgstPaise: true,
          sgstPaise: true,
          igstPaise: true,
          roundOffPaise: true,
          amountInWords: true,
          reason: true,
          snapshot: true,
          snapshotSha256: true,
          pdfAttempts: true,
          pdfError: true,
          pdfRenderedAt: true,
          irn: true,
          issuedBy: true,
          lines: { orderBy: { lineNo: 'asc' }, select: LINE_SELECT },
        },
      }),
    );
    if (doc === null) return null;
    const linked = await withPrismaErrors(() =>
      this.db.taxDocument.findMany({
        where: {
          OR: [
            { originalDocId: id },
            ...(doc.originalDocId === null ? [] : [{ id: doc.originalDocId }]),
          ],
        },
        orderBy: { issuedAt: 'asc' },
        select: SUMMARY_SELECT,
      }),
    );
    return { doc, linked: linked as TaxDocumentSummary[] };
  }

  /** FAILED → PENDING with a fresh attempt budget (conditional: a running render is untouched). */
  async retryPdf(id: string): Promise<boolean> {
    const { count } = await withPrismaErrors(() =>
      this.db.taxDocument.updateMany({
        where: { id, pdfStatus: 'FAILED' },
        data: { pdfStatus: 'PENDING', pdfAttempts: 0, pdfError: null },
      }),
    );
    return count === 1;
  }

  /** Export batch: ascending id keyset over an IST date range (exact issuedAt bounds). */
  exportBatch(from: Date, to: Date, afterId: string | null, limit: number) {
    return withPrismaErrors(() =>
      this.db.taxDocument.findMany({
        where: {
          issuedAt: { gte: from, lt: to },
          id: {
            ...(afterId === null
              ? { gte: uuidv7Floor(new Date(from.getTime() - ID_SLACK_MS)) }
              : { gt: afterId }),
            lt: uuidv7Floor(new Date(to.getTime() + ID_SLACK_MS)),
          },
        },
        orderBy: { id: 'asc' },
        take: limit,
        select: {
          id: true,
          docType: true,
          docNo: true,
          status: true,
          orderNo: true,
          issuedAt: true,
          buyerGstin: true,
          placeOfSupply: true,
          supplyType: true,
          gstr1Section: true,
          reverseCharge: true,
          grandTotalPaise: true,
          originalDocId: true,
          snapshot: true,
        },
      }),
    );
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
          -- the IN list matches the partial index "tax_documents_pdf_due_idx" (never a full scan)
          WHERE "pdfStatus" IN ('PENDING', 'RENDERING', 'FAILED')
            AND ("pdfStatus" = 'PENDING'
             OR ("pdfStatus" = 'FAILED' AND "pdfAttempts" < ${maxAttempts}
                 AND "updatedAt" < now() - make_interval(secs => least(3600, 30 * power(2, "pdfAttempts"))))
             OR ("pdfStatus" = 'RENDERING' AND "updatedAt" < ${new Date(Date.now() - staleMs)}))
          ORDER BY "updatedAt"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING "id", "docNo", "fy", "snapshot", "snapshotSha256", "pdfAttempts"`,
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
  snapshotSha256: string;
  pdfAttempts: number;
}
