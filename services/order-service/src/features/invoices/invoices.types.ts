/** Invoice feature types. Money is integer paise (bigint) everywhere in this feature. */

export type TaxDocumentType = 'TAX_INVOICE' | 'BILL_OF_SUPPLY' | 'CREDIT_NOTE';
export type SupplyType = 'INTRA' | 'INTER';

/** The seller of record (config; validated at issue). */
export interface SellerInfo {
  gstin: string | null;
  legalName: string | null;
  address: string | null;
  stateCode: string;
  /** Invoice and credit-note number prefixes, e.g. FX / CN. */
  invoiceSeries: string;
  creditNoteSeries: string;
  /** Inter-state B2C invoices above this are GSTR-1 B2CL. */
  b2clThresholdPaise: bigint;
}

/** One order line exactly as snapshotted at checkout (D-31: GST already rounded per line). */
export interface OrderLineFacts {
  lineNo: number;
  variantId: string;
  sku: string;
  name: string;
  hsnCode: string;
  gstRateBp: number;
  qty: number;
  cancelledQty: number;
  unitPricePaise: bigint;
  grossPaise: bigint;
  taxablePaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
}

export interface FreightFacts {
  sac: string;
  gstRateBp: number;
  taxablePaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
}

/** Everything an invoice needs, read from the order under its row lock (never re-priced). */
export interface InvoiceOrderFacts {
  orderId: string;
  orderNo: string;
  userId: string;
  farmId: string;
  status: string;
  placedAt: Date;
  currency: string;
  billing: { name: string; gstin: string | null; placeOfSupply: string };
  /** user-service address snapshot taken at checkout. */
  deliveryAddress: Record<string, unknown>;
  lines: OrderLineFacts[];
  freight: FreightFacts | null;
  payment: { method: string | null; paidAt: Date | null };
}

/** What this shipment dispatches. */
export interface ShipmentRequest {
  shipmentId: string;
  lines: { lineNo: number; qty: number }[];
}

/** One stored line of an issued invoice (paise as bigint). */
export interface InvoiceLineRow {
  lineNo: number;
  kind: 'GOODS' | 'FREIGHT';
  orderLineNo: number | null;
  variantId: string | null;
  sku: string | null;
  description: string;
  hsnSac: string;
  qty: number;
  unitPricePaise: bigint;
  grossPaise: bigint;
  discountPaise: bigint;
  taxablePaise: bigint;
  gstRateBp: number;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
  totalPaise: bigint;
}

/** The active (not voided) invoice of a shipment, with what was already credited against it. */
export interface ActiveInvoice {
  id: string;
  docType: TaxDocumentType;
  docNo: string;
  fy: string;
  status: 'ISSUED' | 'PARTIALLY_CREDITED' | 'CREDITED';
  orderId: string;
  orderNo: string;
  shipmentId: string;
  userId: string;
  farmId: string;
  sellerGstin: string;
  sellerStateCode: string;
  buyerGstin: string | null;
  placeOfSupply: string;
  supplyType: SupplyType;
  issuedAt: Date;
  /** Hash of the dispatched lines the invoice was issued for (suffix of its idempotency key). */
  linesHash: string;
  snapshot: InvoiceSnapshot;
  lines: InvoiceLineRow[];
  /** Units already credited per invoice line (`lineNo` of the INVOICE line). */
  creditedQty: ReadonlyMap<number, number>;
  creditNotes: number;
}

/** A credit request against one invoice: units per ORDER line, or the whole remainder. */
export type CreditLines = { orderLineNo: number; qty: number }[] | 'ALL';

/** A validated credit note before it gets its number. */
export interface CreditDraft {
  lines: DraftLine[];
  hsnSummary: HsnSummaryRow[];
  totals: Totals;
  amountInWords: string;
  /** CDNR (registered buyer) · CDNUR (original was B2CL) · B2CS (net adjustment of table 7). */
  gstr1Section: 'CDNR' | 'CDNUR' | 'B2CS';
  /** True when the invoice is fully credited after this note. */
  fullyCredited: boolean;
}

/** Quantities already billed on earlier invoices of the order. */
export interface AlreadyInvoiced {
  qtyByLine: ReadonlyMap<number, number>;
  freightInvoiced: boolean;
}

export interface DraftLine {
  lineNo: number;
  kind: 'GOODS' | 'FREIGHT';
  orderLineNo: number | null;
  variantId: string | null;
  sku: string | null;
  description: string;
  hsnSac: string;
  qty: number;
  unitPricePaise: bigint;
  grossPaise: bigint;
  discountPaise: bigint;
  taxablePaise: bigint;
  gstRateBp: number;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
  totalPaise: bigint;
}

export interface Totals {
  taxablePaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
  totalTaxPaise: bigint;
  roundOffPaise: bigint;
  grandTotalPaise: bigint;
}

export interface HsnSummaryRow {
  hsnSac: string;
  gstRateBp: number;
  qty: number;
  taxablePaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
}

/** A validated invoice before it gets its number. */
export interface InvoiceDraft {
  docType: 'TAX_INVOICE' | 'BILL_OF_SUPPLY';
  supplyType: SupplyType;
  gstr1Section: 'B2B' | 'B2CL' | 'B2CS';
  lines: DraftLine[];
  hsnSummary: HsnSummaryRow[];
  totals: Totals;
  amountInWords: string;
}

export interface Issue {
  path: string;
  message: string;
}

/** A stored document as callers see it (money as paise numbers + rupee strings via views later). */
export interface IssuedDocument {
  id: string;
  docType: TaxDocumentType;
  docNo: string;
  orderId: string;
  shipmentId: string | null;
  grandTotalPaise: bigint;
  issuedAt: Date;
  /** True when this call returned an existing document (same idempotency key). */
  replayed: boolean;
  /** Invoices: hash of the dispatched lines (the warehouse re-checks it at gate-out). */
  linesHash?: string;
  /** Invoices: the earlier invoice of the same shipment voided by this issue, if any. */
  voidedDocNo?: string | null;
}

/** One row of the customer / admin document lists (no snapshot JSON: lists stay small). */
export interface TaxDocumentSummary {
  id: string;
  docType: TaxDocumentType;
  docNo: string;
  status: 'ISSUED' | 'PARTIALLY_CREDITED' | 'CREDITED';
  orderId: string;
  orderNo: string;
  shipmentId: string | null;
  originalDocId: string | null;
  buyerGstin: string | null;
  placeOfSupply: string;
  supplyType: SupplyType;
  gstr1Section: string;
  taxablePaise: bigint;
  totalTaxPaise: bigint;
  grandTotalPaise: bigint;
  pdfStatus: 'PENDING' | 'RENDERING' | 'READY' | 'FAILED';
  issuedAt: Date;
}

/** What a download needs (ownership already checked by the query). */
export interface DownloadTarget {
  id: string;
  docNo: string;
  fy: string;
  pdfStatus: 'PENDING' | 'RENDERING' | 'READY' | 'FAILED';
  pdfKey: string | null;
  pdfSha256: string | null;
  snapshot: unknown;
  snapshotSha256: string;
}

/** Admin register filters (keyset on issuedAt DESC, id DESC). */
export interface InvoiceSearch {
  q?: string;
  orderId?: string;
  userId?: string;
  farmId?: string;
  docType?: TaxDocumentType;
  status?: 'ISSUED' | 'PARTIALLY_CREDITED' | 'CREDITED';
  pdfStatus?: 'PENDING' | 'RENDERING' | 'READY' | 'FAILED';
  b2b?: boolean;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
}

/** One line as frozen in the snapshot (paise as numbers). */
export interface SnapshotLine {
  lineNo: number;
  kind: 'GOODS' | 'FREIGHT';
  orderLineNo: number | null;
  sku: string | null;
  description: string;
  hsnSac: string;
  qty: number;
  unitPricePaise: number;
  grossPaise: number;
  discountPaise: number;
  taxablePaise: number;
  gstRateBp: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
}

/** The complete document as issued (stored as JSON + SHA-256; the PDF is rendered ONLY from it). */
export interface InvoiceSnapshot {
  version: 1;
  document: {
    id: string;
    docType: TaxDocumentType;
    docNo: string;
    fy: string;
    issuedAt: string;
    supplyType: SupplyType;
    reverseCharge: boolean;
    gstr1Section: string;
    currency: string;
  };
  seller: {
    legalName: string | null;
    gstin: string | null;
    address: string | null;
    stateCode: string;
    stateName: string | null;
  };
  buyer: {
    name: string;
    gstin: string | null;
    placeOfSupply: string;
    placeOfSupplyName: string | null;
    billTo: Record<string, unknown>;
    shipTo: Record<string, unknown>;
  };
  order: { orderId: string; orderNo: string; placedAt: string; shipmentId: string | null };
  /** Credit notes: the invoice they reduce. */
  original?: { docNo: string; issuedAt: string };
  lines: SnapshotLine[];
  hsnSummary: {
    hsnSac: string;
    gstRateBp: number;
    qty: number;
    taxablePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
  }[];
  totals: {
    taxablePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    totalTaxPaise: number;
    roundOffPaise: number;
    grandTotalPaise: number;
  };
  amountInWords: string;
  payment: { method: string | null; paidAt: string | null; status: string };
}
