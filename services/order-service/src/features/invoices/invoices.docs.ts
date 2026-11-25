import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, IDS } from '../../docs/shared.js';

export const INVOICES_TAG = 'Invoices';
export const ADMIN_INVOICES_TAG = 'Admin Invoices';

const AUTH_BUYER =
  'Bearer access token of a `CUSTOMER` with full scope. Own orders only: another buyer’s order or document answers exactly like a missing one (empty list / 404).';

const EXAMPLE_DOC = {
  id: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7d01',
  docType: 'TAX_INVOICE',
  docNo: 'FX/2627/0000123',
  status: 'ISSUED',
  orderId: IDS.order,
  orderNo: 'ORD-26-0091842',
  shipmentId: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7e01',
  originalDocId: null,
  buyerGstin: null,
  placeOfSupply: '37',
  supplyType: 'INTRA',
  gstr1Section: 'B2CS',
  taxable: '14284.75',
  totalTax: '2571.25',
  grandTotal: '16856.00',
  pdfStatus: 'READY',
  issuedAt: '2026-10-04T03:40:12.000Z',
};

/** One tax document (invoice, bill of supply or credit note) in lists. */
export const TaxDocument = Joi.object({
  id: Joi.string().uuid(),
  docType: Joi.string().valid('TAX_INVOICE', 'BILL_OF_SUPPLY', 'CREDIT_NOTE'),
  docNo: Joi.string().description('Series/FY/serial, ≤ 16 characters (GST rule 46)'),
  status: Joi.string()
    .valid('ISSUED', 'PARTIALLY_CREDITED', 'CREDITED')
    .description('Invoices only move forward as credit notes reduce them'),
  orderId: Joi.string().uuid(),
  orderNo: Joi.string(),
  shipmentId: Joi.string().uuid().allow(null).description('The consignment it bills / credits'),
  originalDocId: Joi.string().uuid().allow(null).description('Credit notes: the invoice reduced'),
  buyerGstin: Joi.string().allow(null),
  placeOfSupply: Joi.string().description('GST state code'),
  supplyType: Joi.string().valid('INTRA', 'INTER'),
  gstr1Section: Joi.string().description('B2B · B2CL · B2CS · CDNR · CDNUR'),
  taxable: Joi.string().description('Rupees with paise'),
  totalTax: Joi.string(),
  grandTotal: Joi.string(),
  pdfStatus: Joi.string()
    .valid('PENDING', 'RENDERING', 'READY', 'FAILED')
    .description('PDF is rendered in the background within seconds of issue'),
  issuedAt: Joi.date(),
}).meta({ className: 'TaxDocument' });

/** One printed line of a document. */
export const TaxDocumentLine = Joi.object({
  lineNo: Joi.number().integer(),
  kind: Joi.string().valid('GOODS', 'FREIGHT'),
  orderLineNo: Joi.number().integer().allow(null),
  sku: Joi.string().allow(null),
  description: Joi.string(),
  hsnSac: Joi.string(),
  qty: Joi.number().integer(),
  unitPrice: Joi.string(),
  gross: Joi.string(),
  discount: Joi.string(),
  taxable: Joi.string(),
  gstRate: Joi.string().description('Percent, e.g. "18.00"'),
  cgst: Joi.string(),
  sgst: Joi.string(),
  igst: Joi.string(),
  total: Joi.string(),
}).meta({ className: 'TaxDocumentLine' });

const Download = Joi.object({
  url: Joi.string().uri().description('Signed, private, single-file URL'),
  expiresAt: Joi.date().description('5 minutes from now'),
}).meta({ className: 'TaxDocumentDownload' });

const PDF_HEADERS = {
  'Content-Type': { description: 'application/pdf', schema: { type: 'string' as const } },
  'Content-Disposition': {
    description: 'attachment; filename="FX-2627-0000123.pdf"',
    schema: { type: 'string' as const },
  },
};

const RETRY_AFTER = {
  summary: 'PDF still rendering (Retry-After: 5)',
  message: 'The PDF is being prepared; retry in a few seconds',
  details: { reason: 'PDF_NOT_READY', pdfStatus: 'RENDERING', retryAfterSeconds: 5 },
};

export const CUSTOMER_DOCS = {
  list: {
    tag: INVOICES_TAG,
    summary: 'Invoices and credit notes of my order',
    description:
      'GST documents of the order, oldest first: one **tax invoice** (or bill of supply) per consignment, issued when it leaves the warehouse (before dispatch: empty list — show "Invoice is issued on dispatch"), plus **credit notes** (short delivery, cancelled consignment). One indexed query, no snapshot payload (p95 < 30 ms).',
    auth: AUTH_BUYER,
    success: {
      status: 200,
      description: 'Documents',
      data: Joi.array().items(TaxDocument),
      example: { success: true, data: [EXAMPLE_DOC] },
    },
  },
  download: {
    tag: INVOICES_TAG,
    summary: '"Download tax invoice": signed link to one document',
    description:
      'Returns `{ url, expiresAt }`: a private signed link (5 min) to the PDF. While the PDF is still rendering (a few seconds after dispatch) → **409 `PDF_NOT_READY` with `Retry-After: 5`**. The document integrity (SHA-256 of the issued snapshot) is checked first. Local dev store only: the PDF bytes are returned directly (`application/pdf`).',
    auth: AUTH_BUYER,
    rateLimit: '30 per user per minute',
    success: {
      status: 200,
      description: 'Signed link',
      data: Download,
      example: {
        success: true,
        data: {
          url: 'https://farmx.blr1.digitaloceanspaces.com/invoices/2627/FX-2627-0000123.pdf?X-Amz-Signature=…',
          expiresAt: '2026-10-04T03:45:12.000Z',
        },
      },
    },
    errors: [404, 409],
    errorExamples: { 409: RETRY_AFTER },
  },
  combined: {
    tag: INVOICES_TAG,
    summary: '"Download Combined Invoices" (one PDF)',
    description:
      'Returns **`application/pdf`** (attachment), not JSON: every invoice and credit note of the order in one file, each starting on a new page with its own "Page x of y". Rendered on request from the immutable issued snapshots (integrity-checked); never waits for the background renderer. At most 20 documents (409 `TOO_MANY_DOCUMENTS`: download them one by one). No document yet → 404 `NO_INVOICES`.',
    auth: AUTH_BUYER,
    rateLimit: '10 per user per minute',
    success: { status: 200, description: 'The PDF file', headers: PDF_HEADERS },
    errors: [404, 409],
  },
} satisfies Record<string, RouteDocs>;

const doc = (d: Omit<RouteDocs, 'tag' | 'auth'> & { permission: string }): RouteDocs => ({
  tag: ADMIN_INVOICES_TAG,
  auth: AUTH_ADMIN,
  ...d,
});

export const ADMIN_DOCS = {
  search: doc({
    summary: 'Invoice register (search)',
    description:
      'Newest first, keyset paging (`cursor`, `limit` ≤ 100; no total count). Filters: `q` (exact document no. or order no.), `orderId`, `userId`, `farmId`, `docType`, `status`, `pdfStatus` (`FAILED` = render problems), `b2b`, `from` / `to` (IST dates, inclusive). Every filter rides an index (date range included).',
    permission: 'invoices.view',
    success: {
      status: 200,
      description: 'A page of documents',
      paginated: true,
      data: Joi.array().items(TaxDocument),
    },
    errors: [422],
  }),
  detail: doc({
    summary: 'Document detail',
    description:
      'The document with every printed line, the frozen snapshot (seller, buyer, addresses, HSN summary, payment), integrity hash, PDF state, and the linked documents (credit notes of an invoice / the invoice of a credit note).',
    permission: 'invoices.view',
    success: { status: 200, description: 'Document' },
    errors: [404],
  }),
  download: doc({
    summary: 'Download a document (audited)',
    description:
      'Signed link (5 min) like the customer download; every staff download writes an audit row. 409 `PDF_NOT_READY` + `Retry-After` while rendering.',
    permission: 'invoices.view',
    rateLimit: '60 per user per minute',
    success: { status: 200, description: 'Signed link', data: Download },
    errors: [404, 409],
    errorExamples: { 409: RETRY_AFTER },
  }),
  retry: doc({
    summary: 'Retry a FAILED PDF',
    description:
      'FAILED → PENDING with a fresh attempt budget; the renderer picks it up within 10 s. Only FAILED documents (409 `NOT_FAILED` otherwise: a running render is never disturbed). Reason required; audited. The document itself never changes (immutable).',
    permission: 'invoices.view',
    rateLimit: '60 writes per user per minute',
    requestExample: { reason: 'Storage outage resolved' },
    success: { status: 200, description: 'Queued' },
    errors: [404, 409, 422],
  }),
  export: doc({
    summary: 'GST register export (CSV)',
    description:
      'Returns **`text/csv`** (attachment), streamed: one row per document × GST rate, GSTR-1 shaped (document type / no. / date, original invoice for credit notes, buyer GSTIN and name, place of supply, supply type, reverse charge, GSTR-1 section, rate, taxable, IGST, CGST, SGST, cess, document value). `from` / `to`: IST dates, inclusive, at most 31 days (422 otherwise). Formula-like cells are neutralised (CSV injection). Audited.',
    permission: 'invoices.export',
    rateLimit: '5 per user per minute',
    success: {
      status: 200,
      description: 'The CSV file',
      headers: {
        'Content-Type': { description: 'text/csv; charset=utf-8', schema: { type: 'string' } },
        'Content-Disposition': {
          description: 'attachment; filename="gst-register-2026-10-01_2026-10-31.csv"',
          schema: { type: 'string' },
        },
      },
    },
    errors: [422],
  }),
} as const;
