import { createHash } from 'node:crypto';

import { ConflictError, InternalError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from '../../adapters/uuid.js';
import { requestHash } from '../../middleware/http.js';
import type { Actor } from '../audit/index.js';
import { toPaise } from '../pricing/index.js';
import { buildCreditNote, buildInvoice, creditNoteDeadline, linesHash } from './invoices.gst.js';
import { renderCombinedPdf, renderInvoicePdf } from './invoices.pdf.js';
import { type RenderJob, istDayStart } from './invoices.repository.js';
import { STATE_NAMES, financialYear, formatDocNo } from './invoices.tax-ids.js';
import type {
  ActiveInvoice,
  CreditDraft,
  CreditLines,
  DownloadTarget,
  DraftLine,
  InvoiceDraft,
  InvoiceOrderFacts,
  InvoiceSearch,
  InvoiceSnapshot,
  IssuedDocument,
  SellerInfo,
  ShipmentRequest,
  TaxDocumentSummary,
} from './invoices.types.js';
import { csvRow, registerRows, REGISTER_HEADER } from './invoices.views.js';

type Deps = Pick<
  Cradle,
  'invoicesRepository' | 'objectStore' | 'config' | 'logger' | 'auditService' | 'runInTransaction'
>;

/** A RENDERING claim older than this belongs to a crashed renderer and is taken over. */
const RENDER_STALE_MS = 5 * 60_000;
/** One render tick keeps claiming batches for at most this long (then the next tick continues). */
const RENDER_BUDGET_MS = 8_000;
/** One document never renders longer than this (a stuck render fails and is retried). */
const RENDER_TIMEOUT_MS = 10_000;
/** Signed download URLs live this long. */
const URL_TTL_SECONDS = 300;
/** The combined PDF carries at most this many documents (beyond: download them one by one). */
export const COMBINED_MAX_DOCS = 20;
/** Combined PDFs kept in memory per replica (LRU). */
const COMBINED_CACHE_ENTRIES = 100;
/** The GST register export covers at most this many days. */
export const EXPORT_MAX_DAYS = 31;

/** invoices/2627/FX-2627-0000123.pdf (private object; never a public URL). */
export const pdfObjectKey = (fy: string, docNo: string) =>
  `invoices/${fy}/${docNo.replaceAll('/', '-')}.pdf`;

const fileName = (docNo: string) => `${docNo.replaceAll('/', '-')}.pdf`;

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${what} timed out after ${String(ms)} ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });

/** Result of a credit request: issued, nothing to credit, or past the s.34 deadline. */
export type CreditResult =
  | { kind: 'ISSUED'; document: IssuedDocument; invoiceDocNo: string }
  | { kind: 'NO_INVOICE' }
  | { kind: 'TIME_BARRED'; invoiceDocNo: string; deadline: Date };

/** What a download returns: a short-lived signed URL (Spaces) or the bytes (local dev store). */
export type DownloadResult =
  { kind: 'URL'; url: string; expiresAt: Date } | { kind: 'BYTES'; file: Buffer; fileName: string };

/**
 * GST tax documents (D-48, D-61). Issue and credit run INSIDE the caller's transaction with the
 * order row already locked (orders feature), so concurrent shipments / credits of one order
 * serialise and always see each other. Lock order is always: order row → invoice sequence row.
 * Documents are immutable (DB triggers); every read that serves bytes first re-verifies the
 * snapshot's SHA-256 (tamper evidence) and, for stored PDFs, the PDF's SHA-256.
 */
export class InvoicesService {
  constructor(private readonly deps: Deps) {}

  // ── Issue (gate-out) ──

  /**
   * Tax invoice (or bill of supply) for one shipment, keyed by the shipment AND a hash of its
   * dispatched lines:
   *  - same lines as the active invoice → that invoice (replay, idempotent);
   *  - different lines (an amendment changed a packed shipment before gate-out) → the active
   *    invoice is VOIDED by a full credit note, then the replacement is issued, in this tx;
   *  - the shipment already left (`dispatched`) → 409 ALREADY_DISPATCHED (never re-invoiced).
   * Invalid data → 409 INVOICE_INVALID with every issue (dispatch is blocked).
   */
  async issueForShipment(
    tx: Tx,
    facts: InvoiceOrderFacts,
    shipment: ShipmentRequest,
    issuedBy: string | null,
    opts: { dispatched: boolean } = { dispatched: false },
  ): Promise<IssuedDocument> {
    const repo = this.deps.invoicesRepository;
    const hash = linesHash(shipment.lines);
    const active = await repo.activeInvoice(tx, facts.orderId, shipment.shipmentId);
    if (active !== null && active.linesHash === hash)
      return { ...this.issued(active), replayed: true, linesHash: hash, voidedDocNo: null };
    if (opts.dispatched)
      throw new ConflictError('The shipment has left; its invoice cannot change', {
        details: { reason: 'ALREADY_DISPATCHED', docNo: active?.docNo ?? null },
      });

    let voidedDocNo: string | null = null;
    if (active !== null) {
      await this.voidInTx(
        tx,
        active,
        'Replaced: dispatched quantities changed before gate-out',
        issuedBy,
      );
      voidedDocNo = active.docNo;
    }

    const seller = this.seller();
    const already = await repo.invoiced(tx, facts.orderId);
    const { draft, issues } = buildInvoice(facts, already, shipment, seller);
    if (draft === null)
      throw new ConflictError('Invoice cannot be issued', {
        details: { reason: 'INVOICE_INVALID', issues },
      });

    // The number is taken last: the sequence row is locked for as short a time as possible.
    const issuedAt = new Date();
    const fy = financialYear(issuedAt);
    const series = seller.invoiceSeries;
    const gstin = seller.gstin ?? '';
    const generation = (await repo.countForShipment(tx, shipment.shipmentId)) + 1;
    const docNo = formatDocNo(series, fy, await repo.nextNumber(tx, gstin, series, fy));
    const id = uuidv7();
    const snapshot = this.snapshot(facts, draft, seller, { id, docNo, fy, issuedAt, shipment });
    await repo.insert(
      tx,
      {
        id,
        docType: draft.docType,
        docNo,
        series,
        fy,
        orderId: facts.orderId,
        orderNo: facts.orderNo,
        shipmentId: shipment.shipmentId,
        originalDocId: null,
        userId: facts.userId,
        farmId: facts.farmId,
        sellerGstin: gstin,
        sellerStateCode: seller.stateCode,
        buyerGstin: facts.billing.gstin,
        placeOfSupply: facts.billing.placeOfSupply,
        supplyType: draft.supplyType,
        gstr1Section: draft.gstr1Section,
        ...draft.totals,
        amountInWords: draft.amountInWords,
        snapshot,
        snapshotSha256: requestHash(snapshot),
        // ship:<shipment>:<lines hash>:<generation> — unique even if quantities flip back.
        idempotencyKey: `ship:${shipment.shipmentId}:${hash}:${String(generation)}`,
        reason: null,
        issuedAt,
        issuedBy,
      },
      draft.lines,
    );
    this.deps.logger.info(
      { docNo, orderId: facts.orderId, shipmentId: shipment.shipmentId, voidedDocNo },
      'tax document issued',
    );
    return {
      id,
      docType: draft.docType,
      docNo,
      orderId: facts.orderId,
      shipmentId: shipment.shipmentId,
      grandTotalPaise: draft.totals.grandTotalPaise,
      issuedAt,
      replayed: false,
      linesHash: hash,
      voidedDocNo,
    };
  }

  // ── Credit notes ──

  /**
   * Credit note against the active invoice of a shipment (shortage, return, void). Idempotent
   * by `cn:<sourceRef>`. Amounts come from the invoice lines with the cumulative rule (never
   * more than invoiced, zero drift). Past the s.34(2) deadline nothing is issued (TIME_BARRED).
   */
  async creditForShipment(
    tx: Tx,
    input: {
      orderId: string;
      shipmentId: string;
      lines: CreditLines;
      sourceRef: string;
      reason: string;
      issuedBy: string | null;
    },
  ): Promise<CreditResult> {
    const repo = this.deps.invoicesRepository;
    const key = `cn:${input.sourceRef}`;
    const existing = await repo.findByKey(tx, key);
    const active = await repo.activeInvoice(tx, input.orderId, input.shipmentId);
    if (existing !== null)
      return {
        kind: 'ISSUED',
        document: { ...existing, replayed: true },
        invoiceDocNo: active?.docNo ?? '',
      };
    if (active === null) return { kind: 'NO_INVOICE' };
    const deadline = creditNoteDeadline(active.fy);
    if (Date.now() > deadline.getTime())
      return { kind: 'TIME_BARRED', invoiceDocNo: active.docNo, deadline };
    const document = await this.issueCredit(
      tx,
      active,
      input.lines,
      key,
      input.reason,
      input.issuedBy,
    );
    return { kind: 'ISSUED', document, invoiceDocNo: active.docNo };
  }

  /**
   * Voids the active invoices of shipments that were cancelled (goods never left, or came back
   * and the shipment was closed). Full credit note `cn:void:<docId>`; idempotent. An invoice that
   * already carries other credit notes is NOT auto-voided (logged for finance), so the exact
   * cumulative arithmetic of every line is never mixed.
   */
  async voidCancelledShipments(
    tx: Tx,
    orderId: string,
    shipmentIds: readonly string[],
  ): Promise<string[]> {
    const voided: string[] = [];
    for (const shipmentId of shipmentIds) {
      const active = await this.deps.invoicesRepository.activeInvoice(tx, orderId, shipmentId);
      if (active === null) continue;
      if (active.creditNotes > 0) {
        this.deps.logger.error(
          { docNo: active.docNo, orderId, shipmentId },
          'cancelled shipment invoice already has credit notes: void it manually',
        );
        continue;
      }
      await this.voidInTx(tx, active, 'Shipment cancelled: goods not supplied', null);
      voided.push(active.docNo);
    }
    return voided;
  }

  private async voidInTx(tx: Tx, active: ActiveInvoice, reason: string, by: string | null) {
    if (active.creditNotes > 0)
      throw new ConflictError('The invoice already has credit notes', {
        details: { reason: 'INVOICE_LOCKED', docNo: active.docNo },
      });
    return this.issueCredit(tx, active, 'ALL', `cn:void:${active.id}`, reason, by);
  }

  private async issueCredit(
    tx: Tx,
    invoice: ActiveInvoice,
    lines: CreditLines,
    idempotencyKey: string,
    reason: string,
    issuedBy: string | null,
  ): Promise<IssuedDocument> {
    const repo = this.deps.invoicesRepository;
    const { draft, issues } = buildCreditNote(invoice, lines);
    if (draft === null)
      throw new ConflictError('Credit note cannot be issued', {
        details: { reason: 'CREDIT_INVALID', issues },
      });
    const issuedAt = new Date();
    const fy = financialYear(issuedAt);
    const series = this.deps.config.CREDIT_NOTE_SERIES;
    const docNo = formatDocNo(
      series,
      fy,
      await repo.nextNumber(tx, invoice.sellerGstin, series, fy),
    );
    const id = uuidv7();
    const snapshot = this.creditSnapshot(invoice, draft, { id, docNo, fy, issuedAt });
    await repo.insert(
      tx,
      {
        id,
        docType: 'CREDIT_NOTE',
        docNo,
        series,
        fy,
        orderId: invoice.orderId,
        orderNo: invoice.orderNo,
        shipmentId: invoice.shipmentId,
        originalDocId: invoice.id,
        userId: invoice.userId,
        farmId: invoice.farmId,
        sellerGstin: invoice.sellerGstin,
        sellerStateCode: invoice.sellerStateCode,
        buyerGstin: invoice.buyerGstin,
        placeOfSupply: invoice.placeOfSupply,
        supplyType: invoice.supplyType,
        gstr1Section: draft.gstr1Section,
        ...draft.totals,
        amountInWords: draft.amountInWords,
        snapshot,
        snapshotSha256: requestHash(snapshot),
        idempotencyKey,
        reason: reason.slice(0, 300),
        issuedAt,
        issuedBy,
      },
      draft.lines,
    );
    await repo.setStatus(tx, invoice.id, draft.fullyCredited ? 'CREDITED' : 'PARTIALLY_CREDITED');
    this.deps.logger.info(
      { docNo, invoiceDocNo: invoice.docNo, grandTotalPaise: String(draft.totals.grandTotalPaise) },
      'credit note issued',
    );
    return {
      id,
      docType: 'CREDIT_NOTE',
      docNo,
      orderId: invoice.orderId,
      shipmentId: invoice.shipmentId,
      grandTotalPaise: draft.totals.grandTotalPaise,
      issuedAt,
      replayed: false,
    };
  }

  // ── PDF rendering ──

  /**
   * Render job: claims documents to render (replica-safe) and renders them with bounded
   * parallelism, batch after batch while the queue is full and the time budget lasts. Each PDF
   * comes ONLY from the stored snapshot (hash re-verified), is stored privately with its
   * SHA-256, then marked READY. Failures back off (30 s × 2^n) up to INVOICE_PDF_MAX_ATTEMPTS,
   * then stay FAILED (admin retry). A stuck render times out after 10 s.
   */
  async renderDue(): Promise<{ rendered: number; failed: number }> {
    const { invoicesRepository: repo, config } = this.deps;
    const batch = config.INVOICE_PDF_CONCURRENCY * 4;
    const deadline = Date.now() + RENDER_BUDGET_MS;
    let rendered = 0;
    let failed = 0;
    for (;;) {
      const jobs = await repo.claimForRender(
        batch,
        config.INVOICE_PDF_MAX_ATTEMPTS,
        RENDER_STALE_MS,
      );
      let next = 0;
      const worker = async () => {
        while (next < jobs.length) {
          const job = jobs[next];
          next += 1;
          if (job === undefined) return;
          try {
            await this.renderOne(job);
            rendered += 1;
          } catch (err) {
            failed += 1;
            this.deps.logger.error(
              { err, docNo: job.docNo, attempt: job.pdfAttempts },
              'invoice PDF failed',
            );
            await repo.markRenderFailed(job.id, job.pdfAttempts, (err as Error).message);
          }
        }
      };
      await Promise.all(Array.from({ length: config.INVOICE_PDF_CONCURRENCY }, worker));
      if (jobs.length < batch || Date.now() > deadline) return { rendered, failed };
    }
  }

  private async renderOne(job: RenderJob): Promise<void> {
    const { objectStore, invoicesRepository: repo, logger } = this.deps;
    const snap = this.verifiedSnapshot(job);
    const pdf = await this.render(snap);
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    const key = pdfObjectKey(job.fy, job.docNo);
    await objectStore.put({
      key,
      body: pdf,
      contentType: 'application/pdf',
      fileName: fileName(job.docNo),
      sha256,
    });
    if (!(await repo.markRendered(job.id, job.pdfAttempts, key, sha256)))
      logger.warn({ docNo: job.docNo }, 'invoice PDF claim lost to another renderer (same bytes)');
  }

  private render(snap: InvoiceSnapshot): Promise<Buffer> {
    return withTimeout(
      renderInvoicePdf(snap, { logoPath: this.deps.config.INVOICE_LOGO_PATH }),
      RENDER_TIMEOUT_MS,
      `render ${snap.document.docNo}`,
    );
  }

  /** The snapshot, after checking it still hashes to the value stored at issue (tamper check). */
  private verifiedSnapshot(t: { docNo: string; snapshot: unknown; snapshotSha256: string }) {
    if (requestHash(t.snapshot) !== t.snapshotSha256) {
      this.deps.logger.fatal({ docNo: t.docNo }, 'ALERT tax document snapshot hash mismatch');
      throw new InternalError('Document integrity check failed');
    }
    return t.snapshot as InvoiceSnapshot;
  }

  /**
   * The PDF bytes of one document: the stored file when READY (its SHA-256 re-verified), else
   * rendered now from the verified snapshot (same deterministic bytes) — never waits for the job.
   */
  async pdfBytes(t: DownloadTarget): Promise<Buffer> {
    const snap = this.verifiedSnapshot(t);
    if (t.pdfStatus === 'READY' && t.pdfKey !== null) {
      try {
        const file = await this.deps.objectStore.get(t.pdfKey);
        if (createHash('sha256').update(file).digest('hex') === t.pdfSha256) return file;
        this.deps.logger.fatal({ docNo: t.docNo }, 'ALERT stored invoice PDF hash mismatch');
      } catch (err) {
        this.deps.logger.warn({ err, docNo: t.docNo }, 'stored invoice PDF unreadable; rendering');
      }
    }
    return this.render(snap);
  }

  /** Signed URL (prod) or bytes (local dev store) of a READY document; 409 while rendering. */
  async downloadOf(t: DownloadTarget): Promise<DownloadResult> {
    this.verifiedSnapshot(t);
    if (t.pdfStatus !== 'READY' || t.pdfKey === null)
      throw new ConflictError('The PDF is being prepared; retry in a few seconds', {
        details: { reason: 'PDF_NOT_READY', pdfStatus: t.pdfStatus, retryAfterSeconds: 5 },
      });
    const url = await this.deps.objectStore.signedUrl(t.pdfKey, fileName(t.docNo), URL_TTL_SECONDS);
    if (url !== null)
      return { kind: 'URL', url, expiresAt: new Date(Date.now() + URL_TTL_SECONDS * 1000) };
    return { kind: 'BYTES', file: await this.pdfBytes(t), fileName: fileName(t.docNo) };
  }

  // ── Customer reads (own documents only: another buyer's ids answer like missing ones) ──

  listForOrder(orderId: string, userId: string): Promise<TaxDocumentSummary[]> {
    return this.deps.invoicesRepository.listForOrder(orderId, userId);
  }

  async customerDownload(orderId: string, userId: string, docId: string): Promise<DownloadResult> {
    const t = await this.deps.invoicesRepository.downloadTarget(docId, { orderId, userId });
    if (t === null) throw new NotFoundError('Document');
    return this.downloadOf(t);
  }

  /**
   * One PDF of every document of the order. Documents are immutable, so the bytes depend only on
   * the set of (id, snapshot hash): that set is the key of a small in-memory LRU (per replica).
   * A repeat download costs one indexed query (ids + hashes, no JSON) and no rendering; a new
   * document changes the set, so a stale combined PDF is never served. A miss verifies every
   * snapshot hash before rendering (integrity), and the cache never leaves process memory.
   */
  async combined(orderId: string, userId: string): Promise<{ file: Buffer; fileName: string }> {
    const repo = this.deps.invoicesRepository;
    const keys = await repo.docKeysForOrder(orderId, userId, COMBINED_MAX_DOCS + 1);
    if (keys.length === 0)
      throw new NotFoundError('Document', { details: { reason: 'NO_INVOICES' } });
    if (keys.length > COMBINED_MAX_DOCS)
      throw new ConflictError(
        `More than ${String(COMBINED_MAX_DOCS)} documents: download them one by one`,
        { details: { reason: 'TOO_MANY_DOCUMENTS' } },
      );
    const cacheKey = `${orderId}|${keys.map((k) => `${k.id}:${k.snapshotSha256}`).join(',')}`;
    const hit = this.combinedCache.get(cacheKey);
    if (hit !== undefined) {
      this.combinedCache.delete(cacheKey); // refresh LRU position
      this.combinedCache.set(cacheKey, hit);
      return hit;
    }
    const rows = await repo.snapshotsForOrder(orderId, userId, COMBINED_MAX_DOCS + 1);
    const snaps = rows.map((r) => this.verifiedSnapshot(r));
    const file = await withTimeout(
      renderCombinedPdf(snaps, { logoPath: this.deps.config.INVOICE_LOGO_PATH }),
      RENDER_TIMEOUT_MS,
      'combined PDF',
    );
    const out = { file, fileName: `${snaps[0]?.order.orderNo ?? orderId}-invoices.pdf` };
    this.combinedCache.set(cacheKey, out);
    while (this.combinedCache.size > COMBINED_CACHE_ENTRIES) {
      const oldest = this.combinedCache.keys().next().value;
      if (oldest === undefined) break;
      this.combinedCache.delete(oldest);
    }
    return out;
  }

  /** LRU of rendered combined PDFs (Map keeps insertion order; bounded: ~100 × ≤ 200 KB). */
  private readonly combinedCache = new Map<string, { file: Buffer; fileName: string }>();

  // ── Warehouse print (internal; the warehouse checks scope before calling) ──

  async shipmentPdf(
    orderId: string,
    shipmentId: string,
  ): Promise<{ file: Buffer; fileName: string; docNo: string }> {
    const repo = this.deps.invoicesRepository;
    const id = await repo.activeInvoiceId(orderId, shipmentId);
    const t = id === null ? null : await repo.downloadTarget(id);
    if (t === null) throw new NotFoundError('Invoice', { details: { reason: 'NO_INVOICE' } });
    return { file: await this.pdfBytes(t), fileName: fileName(t.docNo), docNo: t.docNo };
  }

  /** Reconcile input: shipments with an active, not fully credited invoice issued since `since`. */
  recentActiveShipments(since: Date, limit: number) {
    return this.deps.invoicesRepository.recentActiveShipments(since, limit);
  }

  // ── Admin register ──

  search(f: InvoiceSearch): Promise<Paginated<TaxDocumentSummary>> {
    return this.deps.invoicesRepository.search(f);
  }

  async detail(id: string) {
    const d = await this.deps.invoicesRepository.detail(id);
    if (d === null) throw new NotFoundError('Document');
    return d;
  }

  /** Staff download: audited (who read which tax document). */
  async adminDownload(actor: Actor, id: string): Promise<DownloadResult> {
    const t = await this.deps.invoicesRepository.downloadTarget(id);
    if (t === null) throw new NotFoundError('Document');
    const result = await this.downloadOf(t);
    await this.deps.runInTransaction((tx) =>
      this.deps.auditService.record(tx, actor, {
        action: 'invoices.downloaded',
        targetType: 'tax_document',
        targetId: id,
        after: { docNo: t.docNo },
      }),
    );
    return result;
  }

  async retryPdf(
    actor: Actor,
    id: string,
    reason: string,
  ): Promise<{ id: string; pdfStatus: 'PENDING' }> {
    const t = await this.deps.invoicesRepository.downloadTarget(id);
    if (t === null) throw new NotFoundError('Document');
    await this.deps.runInTransaction(async (tx) => {
      if (!(await this.deps.invoicesRepository.retryPdf(id)))
        throw new ConflictError('Only a FAILED PDF can be retried', {
          details: { reason: 'NOT_FAILED', pdfStatus: t.pdfStatus },
        });
      await this.deps.auditService.record(tx, actor, {
        action: 'invoices.pdf_retried',
        targetType: 'tax_document',
        targetId: id,
        reason,
        after: { docNo: t.docNo },
      });
    });
    return { id, pdfStatus: 'PENDING' };
  }

  /**
   * GST register (GSTR-1 shaped): one CSV row per document × GST rate, IST dates, rupees with
   * paise. Streams in id-keyset batches of 1,000 (constant memory, first byte immediately).
   * Audited before the first row.
   */
  async *exportCsv(actor: Actor, from: string, to: string): AsyncGenerator<string> {
    const start = istDayStart(from);
    const end = new Date(istDayStart(to).getTime() + 86_400_000);
    const days = (end.getTime() - start.getTime()) / 86_400_000;
    if (!(days >= 1))
      throw new ValidationError([{ path: 'to', message: 'must be on or after from' }]);
    if (days > EXPORT_MAX_DAYS)
      throw new ValidationError([
        { path: 'to', message: `the range must be at most ${String(EXPORT_MAX_DAYS)} days` },
      ]);
    await this.deps.runInTransaction((tx) =>
      this.deps.auditService.record(tx, actor, {
        action: 'invoices.exported',
        targetType: 'tax_document',
        targetId: '00000000-0000-0000-0000-000000000000',
        after: { from, to },
      }),
    );
    yield csvRow(REGISTER_HEADER);
    let after: string | null = null;
    for (;;) {
      const batch = await this.deps.invoicesRepository.exportBatch(start, end, after, 1000);
      for (const doc of batch) for (const row of registerRows(doc)) yield csvRow(row);
      if (batch.length < 1000) return;
      after = batch.at(-1)?.id ?? null;
    }
  }

  // ── helpers ──

  private issued(a: ActiveInvoice): Omit<IssuedDocument, 'replayed'> {
    return {
      id: a.id,
      docType: a.docType,
      docNo: a.docNo,
      orderId: a.orderId,
      shipmentId: a.shipmentId,
      grandTotalPaise: BigInt(a.snapshot.totals.grandTotalPaise),
      issuedAt: a.issuedAt,
    };
  }

  private seller(): SellerInfo {
    const c = this.deps.config;
    return {
      gstin: c.SELLER_GSTIN ?? null,
      legalName: c.SELLER_LEGAL_NAME ?? null,
      address: c.SELLER_ADDRESS ?? null,
      stateCode: c.SELLER_STATE_CODE,
      invoiceSeries: c.INVOICE_SERIES,
      creditNoteSeries: c.CREDIT_NOTE_SERIES,
      b2clThresholdPaise: BigInt(toPaise(c.B2CL_THRESHOLD)),
    };
  }

  /** Credit note snapshot: seller, buyer and order exactly as on the original invoice. */
  private creditSnapshot(
    invoice: ActiveInvoice,
    draft: CreditDraft,
    doc: { id: string; docNo: string; fy: string; issuedAt: Date },
  ): InvoiceSnapshot {
    const orig = invoice.snapshot;
    return {
      version: 1,
      document: {
        id: doc.id,
        docType: 'CREDIT_NOTE',
        docNo: doc.docNo,
        fy: doc.fy,
        issuedAt: doc.issuedAt.toISOString(),
        supplyType: orig.document.supplyType,
        reverseCharge: false,
        gstr1Section: draft.gstr1Section,
        currency: orig.document.currency,
      },
      seller: orig.seller,
      buyer: orig.buyer,
      order: orig.order,
      original: { docNo: invoice.docNo, issuedAt: orig.document.issuedAt },
      lines: draft.lines.map(snapLine),
      hsnSummary: draft.hsnSummary.map((h) => ({
        hsnSac: h.hsnSac,
        gstRateBp: h.gstRateBp,
        qty: h.qty,
        taxablePaise: Number(h.taxablePaise),
        cgstPaise: Number(h.cgstPaise),
        sgstPaise: Number(h.sgstPaise),
        igstPaise: Number(h.igstPaise),
      })),
      totals: numTotals(draft.totals),
      amountInWords: draft.amountInWords,
      payment: orig.payment,
    };
  }

  /**
   * The complete document as issued: everything the PDF, exports and audits need, frozen (JSON,
   * paise as numbers). Its SHA-256 is stored with it.
   */
  private snapshot(
    facts: InvoiceOrderFacts,
    draft: InvoiceDraft,
    seller: SellerInfo,
    doc: { id: string; docNo: string; fy: string; issuedAt: Date; shipment: ShipmentRequest },
  ): InvoiceSnapshot {
    return {
      version: 1,
      document: {
        id: doc.id,
        docType: draft.docType,
        docNo: doc.docNo,
        fy: doc.fy,
        issuedAt: doc.issuedAt.toISOString(),
        supplyType: draft.supplyType,
        reverseCharge: false,
        gstr1Section: draft.gstr1Section,
        currency: facts.currency,
      },
      seller: {
        legalName: seller.legalName,
        gstin: seller.gstin,
        address: seller.address,
        stateCode: seller.stateCode,
        stateName: STATE_NAMES[seller.stateCode] ?? null,
      },
      buyer: {
        name: facts.billing.name,
        gstin: facts.billing.gstin,
        placeOfSupply: facts.billing.placeOfSupply,
        placeOfSupplyName: STATE_NAMES[facts.billing.placeOfSupply] ?? null,
        billTo: facts.deliveryAddress,
        shipTo: facts.deliveryAddress,
      },
      order: {
        orderId: facts.orderId,
        orderNo: facts.orderNo,
        placedAt: facts.placedAt.toISOString(),
        shipmentId: doc.shipment.shipmentId,
      },
      lines: draft.lines.map(snapLine),
      hsnSummary: draft.hsnSummary.map((h) => ({
        hsnSac: h.hsnSac,
        gstRateBp: h.gstRateBp,
        qty: h.qty,
        taxablePaise: Number(h.taxablePaise),
        cgstPaise: Number(h.cgstPaise),
        sgstPaise: Number(h.sgstPaise),
        igstPaise: Number(h.igstPaise),
      })),
      totals: numTotals(draft.totals),
      amountInWords: draft.amountInWords,
      payment: {
        method: facts.payment.method,
        paidAt: facts.payment.paidAt?.toISOString() ?? null,
        status: 'PAID',
      },
    };
  }
}

const snapLine = (l: DraftLine) => ({
  lineNo: l.lineNo,
  kind: l.kind,
  orderLineNo: l.orderLineNo,
  sku: l.sku,
  description: l.description,
  hsnSac: l.hsnSac,
  qty: l.qty,
  unitPricePaise: Number(l.unitPricePaise),
  grossPaise: Number(l.grossPaise),
  discountPaise: Number(l.discountPaise),
  taxablePaise: Number(l.taxablePaise),
  gstRateBp: l.gstRateBp,
  cgstPaise: Number(l.cgstPaise),
  sgstPaise: Number(l.sgstPaise),
  igstPaise: Number(l.igstPaise),
  totalPaise: Number(l.totalPaise),
});

const numTotals = (t: InvoiceDraft['totals']) => ({
  taxablePaise: Number(t.taxablePaise),
  cgstPaise: Number(t.cgstPaise),
  sgstPaise: Number(t.sgstPaise),
  igstPaise: Number(t.igstPaise),
  totalTaxPaise: Number(t.totalTaxPaise),
  roundOffPaise: Number(t.roundOffPaise),
  grandTotalPaise: Number(t.grandTotalPaise),
});
