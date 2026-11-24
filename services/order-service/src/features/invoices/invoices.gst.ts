import { STATE_NAMES, isValidGstin, isValidHsn } from './invoices.tax-ids.js';
import { amountInWords } from './invoices.words.js';
import type {
  AlreadyInvoiced,
  DraftLine,
  HsnSummaryRow,
  InvoiceDraft,
  InvoiceOrderFacts,
  Issue,
  SellerInfo,
  ShipmentRequest,
  Totals,
} from './invoices.types.js';

/**
 * Pure invoice builder (no I/O). The order already carries GST computed half-up per line on the
 * discounted value (D-31); an invoice never re-prices, it BILLS a share of each order line.
 *
 * Share of a line for this shipment = cumulative(before + k) − cumulative(before), where
 * cumulative(n) = round_half_up(lineAmount × n / orderedQty). Every component uses the same rule,
 * so all shipments of a line add up to the order line EXACTLY (no stored running totals, no
 * drift), whatever the split; units cancelled before dispatch are simply never billed.
 * Freight is billed in full on the first invoice of the order.
 */

const INVOICEABLE = new Set([
  'CONFIRMED',
  'IN_FULFILMENT',
  'PARTIALLY_DELIVERED',
  'DELIVERED',
  'COMPLETED',
]);

/** round_half_up(amount × n / d) in exact integer arithmetic (amount ≥ 0, 0 ≤ n ≤ d, d > 0). */
export const cumulative = (amount: bigint, n: number, d: number): bigint =>
  (amount * BigInt(n) * 2n + BigInt(d)) / (BigInt(d) * 2n);

const share = (amount: bigint, before: number, k: number, qty: number): bigint =>
  cumulative(amount, before + k, qty) - cumulative(amount, before, qty);

export function buildInvoice(
  facts: InvoiceOrderFacts,
  already: AlreadyInvoiced,
  shipment: ShipmentRequest,
  seller: SellerInfo,
): { draft: InvoiceDraft | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  // ── Parties ──
  if (!INVOICEABLE.has(facts.status))
    add('order.status', `order is ${facts.status}; only CONFIRMED orders are invoiced`);
  if (seller.gstin === null || seller.legalName === null || seller.address === null)
    add('seller', 'seller GSTIN, legal name and address must be configured');
  else if (!isValidGstin(seller.gstin)) add('seller.gstin', 'invalid GSTIN (format or checksum)');
  else if (seller.gstin.slice(0, 2) !== seller.stateCode)
    add('seller.stateCode', 'seller state code does not match the GSTIN');
  const buyerGstin = facts.billing.gstin;
  if (buyerGstin !== null && !isValidGstin(buyerGstin))
    add('buyer.gstin', 'invalid GSTIN (format or checksum)');
  const pos = facts.billing.placeOfSupply;
  if (STATE_NAMES[pos] === undefined) add('buyer.placeOfSupply', `unknown state code "${pos}"`);
  const supplyType = pos === seller.stateCode ? 'INTRA' : 'INTER';

  // ── Lines ──
  if (shipment.lines.length === 0) add('shipment.lines', 'nothing to invoice');
  const seen = new Set<number>();
  const lines: DraftLine[] = [];
  for (const [i, req] of shipment.lines.entries()) {
    const path = `shipment.lines[${String(i)}]`;
    const line = facts.lines.find((l) => l.lineNo === req.lineNo);
    if (seen.has(req.lineNo)) add(path, `line ${String(req.lineNo)} appears twice`);
    seen.add(req.lineNo);
    if (line === undefined) {
      add(path, `order has no line ${String(req.lineNo)}`);
      continue;
    }
    const before = already.qtyByLine.get(line.lineNo) ?? 0;
    const open = line.qty - line.cancelledQty - before;
    if (!Number.isInteger(req.qty) || req.qty < 1 || req.qty > open) {
      add(path, `qty must be 1..${String(Math.max(open, 0))} for line ${String(line.lineNo)}`);
      continue;
    }
    if (!isValidHsn(line.hsnCode)) add(`${path}.hsn`, `invalid HSN "${line.hsnCode}"`);
    if (supplyType === 'INTRA' ? line.igstPaise !== 0n : line.cgstPaise + line.sgstPaise !== 0n)
      add(`${path}.tax`, 'order line tax does not match the supply type');
    const gross = share(line.grossPaise, before, req.qty, line.qty);
    const taxable = share(line.taxablePaise, before, req.qty, line.qty);
    const cgst = share(line.cgstPaise, before, req.qty, line.qty);
    const sgst = share(line.sgstPaise, before, req.qty, line.qty);
    const igst = share(line.igstPaise, before, req.qty, line.qty);
    lines.push({
      lineNo: lines.length + 1,
      kind: 'GOODS',
      orderLineNo: line.lineNo,
      variantId: line.variantId,
      sku: line.sku,
      description: line.name,
      hsnSac: line.hsnCode,
      qty: req.qty,
      unitPricePaise: line.unitPricePaise,
      grossPaise: gross,
      discountPaise: gross - taxable,
      taxablePaise: taxable,
      gstRateBp: line.gstRateBp,
      cgstPaise: cgst,
      sgstPaise: sgst,
      igstPaise: igst,
      totalPaise: taxable + cgst + sgst + igst,
    });
  }

  // ── Freight: in full on the first invoice ──
  const f = facts.freight;
  if (f !== null && f.taxablePaise > 0n && !already.freightInvoiced && lines.length > 0) {
    if (!isValidHsn(f.sac)) add('freight.sac', `invalid SAC "${f.sac}"`);
    lines.push({
      lineNo: lines.length + 1,
      kind: 'FREIGHT',
      orderLineNo: null,
      variantId: null,
      sku: null,
      description: 'Freight / delivery charges',
      hsnSac: f.sac,
      qty: 1,
      unitPricePaise: f.taxablePaise,
      grossPaise: f.taxablePaise,
      discountPaise: 0n,
      taxablePaise: f.taxablePaise,
      gstRateBp: f.gstRateBp,
      cgstPaise: f.cgstPaise,
      sgstPaise: f.sgstPaise,
      igstPaise: f.igstPaise,
      totalPaise: f.taxablePaise + f.cgstPaise + f.sgstPaise + f.igstPaise,
    });
  }

  const totals = totalsOf(lines);
  if (lines.length > 0 && totals.grandTotalPaise <= 0n)
    add('totals.grandTotal', 'invoice total must be positive');
  if (issues.length > 0) return { draft: null, issues };

  const docType = lines.every((l) => l.gstRateBp === 0) ? 'BILL_OF_SUPPLY' : 'TAX_INVOICE';
  return {
    draft: {
      docType,
      supplyType,
      gstr1Section:
        buyerGstin !== null
          ? 'B2B'
          : supplyType === 'INTER' && totals.grandTotalPaise > seller.b2clThresholdPaise
            ? 'B2CL'
            : 'B2CS',
      lines,
      hsnSummary: hsnSummary(lines),
      totals,
      amountInWords: amountInWords(totals.grandTotalPaise),
    },
    issues,
  };
}

/** Header = Σ lines (no rupee round-off: the buyer paid the exact paise total). */
export const totalsOf = (lines: readonly DraftLine[]): Totals => {
  const sum = (pick: (l: DraftLine) => bigint) => lines.reduce((acc, l) => acc + pick(l), 0n);
  const taxable = sum((l) => l.taxablePaise);
  const cgst = sum((l) => l.cgstPaise);
  const sgst = sum((l) => l.sgstPaise);
  const igst = sum((l) => l.igstPaise);
  return {
    taxablePaise: taxable,
    cgstPaise: cgst,
    sgstPaise: sgst,
    igstPaise: igst,
    totalTaxPaise: cgst + sgst + igst,
    roundOffPaise: 0n,
    grandTotalPaise: taxable + cgst + sgst + igst,
  };
};

/** HSN / SAC × rate summary (sums of already-rounded line amounts; never re-rounded). */
export const hsnSummary = (lines: readonly DraftLine[]): HsnSummaryRow[] => {
  const rows = new Map<string, HsnSummaryRow>();
  for (const l of lines) {
    const key = `${l.hsnSac}|${String(l.gstRateBp)}`;
    const row = rows.get(key) ?? {
      hsnSac: l.hsnSac,
      gstRateBp: l.gstRateBp,
      qty: 0,
      taxablePaise: 0n,
      cgstPaise: 0n,
      sgstPaise: 0n,
      igstPaise: 0n,
    };
    row.qty += l.qty;
    row.taxablePaise += l.taxablePaise;
    row.cgstPaise += l.cgstPaise;
    row.sgstPaise += l.sgstPaise;
    row.igstPaise += l.igstPaise;
    rows.set(key, row);
  }
  return [...rows.values()];
};
