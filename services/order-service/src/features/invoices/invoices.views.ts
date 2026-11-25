import { fromPaise } from '../pricing/index.js';
import type { InvoiceSnapshot, TaxDocumentSummary } from './invoices.types.js';

/** API shape of one document row (rupees as "1420.00" strings, like every order amount). */
export interface TaxDocumentView {
  id: string;
  docType: TaxDocumentSummary['docType'];
  docNo: string;
  status: TaxDocumentSummary['status'];
  orderId: string;
  orderNo: string;
  shipmentId: string | null;
  originalDocId: string | null;
  buyerGstin: string | null;
  placeOfSupply: string;
  supplyType: TaxDocumentSummary['supplyType'];
  gstr1Section: string;
  taxable: string;
  totalTax: string;
  grandTotal: string;
  pdfStatus: TaxDocumentSummary['pdfStatus'];
  issuedAt: Date;
}

const rupees = (p: bigint | number) => fromPaise(Number(p));

export const toDocumentView = (d: TaxDocumentSummary): TaxDocumentView => ({
  id: d.id,
  docType: d.docType,
  docNo: d.docNo,
  status: d.status,
  orderId: d.orderId,
  orderNo: d.orderNo,
  shipmentId: d.shipmentId,
  originalDocId: d.originalDocId,
  buyerGstin: d.buyerGstin,
  placeOfSupply: d.placeOfSupply,
  supplyType: d.supplyType,
  gstr1Section: d.gstr1Section,
  taxable: rupees(d.taxablePaise),
  totalTax: rupees(d.totalTaxPaise),
  grandTotal: rupees(d.grandTotalPaise),
  pdfStatus: d.pdfStatus,
  issuedAt: d.issuedAt,
});

// ── GST register CSV (GSTR-1 shaped: one row per document × GST rate) ──

export const REGISTER_HEADER = [
  'Document type',
  'Document no',
  'Document date',
  'Status',
  'Order no',
  'Original invoice no',
  'Original invoice date',
  'Buyer GSTIN',
  'Buyer name',
  'Place of supply',
  'Supply type',
  'Reverse charge',
  'GSTR-1 section',
  'GST rate %',
  'Taxable value',
  'IGST',
  'CGST',
  'SGST',
  'Cess',
  'Document value',
] as const;

const istDate = (d: Date | string) =>
  new Date(new Date(d).getTime() + 330 * 60_000).toISOString().slice(0, 10);

export interface RegisterSource {
  docType: string;
  docNo: string;
  status: string;
  orderNo: string;
  issuedAt: Date;
  buyerGstin: string | null;
  placeOfSupply: string;
  supplyType: string;
  gstr1Section: string;
  reverseCharge: boolean;
  grandTotalPaise: bigint;
  snapshot: unknown;
}

/** Rows of one document: its HSN summary grouped by rate (amounts already rounded at issue). */
export const registerRows = (d: RegisterSource): string[][] => {
  const snap = d.snapshot as InvoiceSnapshot;
  const byRate = new Map<number, { taxable: number; igst: number; cgst: number; sgst: number }>();
  for (const h of snap.hsnSummary) {
    const r = byRate.get(h.gstRateBp) ?? { taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    r.taxable += h.taxablePaise;
    r.igst += h.igstPaise;
    r.cgst += h.cgstPaise;
    r.sgst += h.sgstPaise;
    byRate.set(h.gstRateBp, r);
  }
  return [...byRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bp, r]) => [
      d.docType,
      d.docNo,
      istDate(d.issuedAt),
      d.status,
      d.orderNo,
      snap.original?.docNo ?? '',
      snap.original === undefined ? '' : istDate(snap.original.issuedAt),
      d.buyerGstin ?? '',
      snap.buyer.name,
      `${d.placeOfSupply}-${snap.buyer.placeOfSupplyName ?? ''}`,
      d.supplyType,
      d.reverseCharge ? 'Y' : 'N',
      d.gstr1Section,
      fromPaise(bp),
      fromPaise(r.taxable),
      fromPaise(r.igst),
      fromPaise(r.cgst),
      fromPaise(r.sgst),
      '0.00',
      fromPaise(Number(d.grandTotalPaise)),
    ]);
};

/**
 * One CSV line (RFC 4180 quoting). Cells that a spreadsheet would run as a formula (= + - @, tab,
 * CR) get a leading apostrophe: buyer names are user input (CSV injection).
 */
export const csvRow = (cells: readonly string[]): string =>
  `${cells
    .map((c) => {
      const safe = /^[=+\-@\t\r]/.test(c) && !/^-?\d+(\.\d+)?$/.test(c) ? `'${c}` : c;
      return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
    })
    .join(',')}\r\n`;
