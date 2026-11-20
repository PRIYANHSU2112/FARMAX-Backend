import { createHash } from 'node:crypto';

import { ConflictError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from '../../adapters/uuid.js';
import { requestHash } from '../../middleware/http.js';
import { toPaise } from '../pricing/index.js';
import { buildInvoice } from './invoices.gst.js';
import { renderInvoicePdf } from './invoices.pdf.js';
import type { RenderJob } from './invoices.repository.js';
import { STATE_NAMES, financialYear, formatDocNo } from './invoices.tax-ids.js';
import type {
  DraftLine,
  InvoiceDraft,
  InvoiceOrderFacts,
  InvoiceSnapshot,
  IssuedDocument,
  SellerInfo,
  ShipmentRequest,
} from './invoices.types.js';

type Deps = Pick<Cradle, 'invoicesRepository' | 'objectStore' | 'config' | 'logger'>;

/** A RENDERING claim older than this belongs to a crashed renderer and is taken over. */
const RENDER_STALE_MS = 5 * 60_000;
/** One render tick keeps claiming batches for at most this long (then the next tick continues). */
const RENDER_BUDGET_MS = 8_000;

/** invoices/2627/FX-2627-0000123.pdf (private object; never a public URL). */
export const pdfObjectKey = (fy: string, docNo: string) =>
  `invoices/${fy}/${docNo.replaceAll('/', '-')}.pdf`;

/**
 * Issues GST tax documents. Called INSIDE the dispatching transaction, with the order row already
 * locked by the caller (orders feature), so concurrent shipments of one order serialise and see
 * each other's billed quantities. Lock order is always: order row → invoice sequence row.
 */
export class InvoicesService {
  constructor(private readonly deps: Deps) {}

  /**
   * Tax invoice (or bill of supply) for one shipment. Idempotent per shipment: a repeat returns
   * the document already issued. Invalid data → 409 INVOICE_INVALID with every issue (dispatch is
   * blocked: goods must not move without an invoice).
   */
  async issueForShipment(
    tx: Tx,
    facts: InvoiceOrderFacts,
    shipment: ShipmentRequest,
    issuedBy: string | null,
  ): Promise<IssuedDocument> {
    const repo = this.deps.invoicesRepository;
    const idempotencyKey = `ship:${shipment.shipmentId}`;
    const existing = await repo.findByKey(tx, idempotencyKey);
    if (existing !== null) return { ...existing, replayed: true };

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
        idempotencyKey,
        reason: null,
        issuedAt,
        issuedBy,
      },
      draft.lines,
    );
    this.deps.logger.info(
      { docNo, orderId: facts.orderId, shipmentId: shipment.shipmentId },
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
    };
  }

  /**
   * Render job: claims documents to render (replica-safe) and renders them with bounded
   * parallelism, batch after batch while the queue is full and the time budget lasts. Each PDF
   * comes ONLY from the stored snapshot, is stored privately with its SHA-256, then marked READY.
   * Failures back off (30 s × 2^n) up to INVOICE_PDF_MAX_ATTEMPTS, then stay FAILED (admin retry).
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
    const { objectStore, invoicesRepository: repo, config, logger } = this.deps;
    const pdf = await renderInvoicePdf(job.snapshot as InvoiceSnapshot, {
      logoPath: config.INVOICE_LOGO_PATH,
    });
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    const key = pdfObjectKey(job.fy, job.docNo);
    await objectStore.put({
      key,
      body: pdf,
      contentType: 'application/pdf',
      fileName: `${job.docNo.replaceAll('/', '-')}.pdf`,
      sha256,
    });
    if (!(await repo.markRendered(job.id, job.pdfAttempts, key, sha256)))
      logger.warn({ docNo: job.docNo }, 'invoice PDF claim lost to another renderer (same bytes)');
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
    const n = (v: bigint) => Number(v);
    const line = (l: DraftLine) => ({
      lineNo: l.lineNo,
      kind: l.kind,
      orderLineNo: l.orderLineNo,
      sku: l.sku,
      description: l.description,
      hsnSac: l.hsnSac,
      qty: l.qty,
      unitPricePaise: n(l.unitPricePaise),
      grossPaise: n(l.grossPaise),
      discountPaise: n(l.discountPaise),
      taxablePaise: n(l.taxablePaise),
      gstRateBp: l.gstRateBp,
      cgstPaise: n(l.cgstPaise),
      sgstPaise: n(l.sgstPaise),
      igstPaise: n(l.igstPaise),
      totalPaise: n(l.totalPaise),
    });
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
      lines: draft.lines.map(line),
      hsnSummary: draft.hsnSummary.map((h) => ({
        hsnSac: h.hsnSac,
        gstRateBp: h.gstRateBp,
        qty: h.qty,
        taxablePaise: n(h.taxablePaise),
        cgstPaise: n(h.cgstPaise),
        sgstPaise: n(h.sgstPaise),
        igstPaise: n(h.igstPaise),
      })),
      totals: {
        taxablePaise: n(draft.totals.taxablePaise),
        cgstPaise: n(draft.totals.cgstPaise),
        sgstPaise: n(draft.totals.sgstPaise),
        igstPaise: n(draft.totals.igstPaise),
        totalTaxPaise: n(draft.totals.totalTaxPaise),
        roundOffPaise: n(draft.totals.roundOffPaise),
        grandTotalPaise: n(draft.totals.grandTotalPaise),
      },
      amountInWords: draft.amountInWords,
      payment: {
        method: facts.payment.method,
        paidAt: facts.payment.paidAt?.toISOString() ?? null,
        status: 'PAID',
      },
    };
  }
}
