import type { InvoiceOrderFacts } from '../invoices/index.js';
import { toBasisPoints, toPaise } from '../pricing/index.js';
import type { OrderWithLines } from './orders.types.js';

const paise = (value: { toString(): string }): bigint => BigInt(toPaise(value.toString()));

interface TraceGroup {
  hsnCode: string;
  rate: number;
  taxable: number;
}
interface PriceTrace {
  invoice?: { freightTaxable?: number; gstByHsn?: TraceGroup[] };
}

/**
 * Order (as snapshotted at checkout, read under its row lock) → invoice facts. Nothing is
 * re-priced and nothing current is read: lines, GST, billing and addresses are the order's own.
 *
 * Freight: its taxable value and SAC / rate come from the checkout price trace (the GST group
 * whose taxable exceeds the item lines of the same code + rate by exactly the freight); its tax is
 * the order header tax minus the sum of the line taxes.
 */
export function toInvoiceFacts(
  order: OrderWithLines,
  paymentMethod: string | null,
): InvoiceOrderFacts {
  const billing = (order.billing ?? {}) as {
    name?: string;
    gstin?: string | null;
    placeOfSupply?: string;
  };
  const lines = order.lines.map((l) => ({
    lineNo: l.lineNo,
    variantId: l.variantId,
    sku: l.sku,
    name: l.name,
    hsnCode: l.hsnCode,
    gstRateBp: toBasisPoints(l.gstRate.toFixed(2)),
    qty: l.qty,
    cancelledQty: l.cancelledQty,
    unitPricePaise: paise(l.unitPrice),
    grossPaise: paise(l.lineGross),
    taxablePaise: paise(l.taxableValue),
    cgstPaise: paise(l.cgst),
    sgstPaise: paise(l.sgst),
    igstPaise: paise(l.igst),
  }));
  const sum = (pick: (l: (typeof lines)[number]) => bigint) =>
    lines.reduce((acc, l) => acc + pick(l), 0n);

  const trace = (order.priceTrace ?? {}) as PriceTrace;
  const freightTaxable = BigInt(trace.invoice?.freightTaxable ?? 0);
  let freight: InvoiceOrderFacts['freight'] = null;
  if (freightTaxable > 0n) {
    const group = (trace.invoice?.gstByHsn ?? []).find((g) => {
      const itemTaxable = lines
        .filter((l) => l.hsnCode === g.hsnCode && l.gstRateBp === g.rate)
        .reduce((acc, l) => acc + l.taxablePaise, 0n);
      return BigInt(g.taxable) - itemTaxable === freightTaxable;
    });
    freight = {
      sac: group?.hsnCode ?? '',
      gstRateBp: group?.rate ?? 0,
      taxablePaise: freightTaxable,
      cgstPaise: paise(order.cgst) - sum((l) => l.cgstPaise),
      sgstPaise: paise(order.sgst) - sum((l) => l.sgstPaise),
      igstPaise: paise(order.igst) - sum((l) => l.igstPaise),
    };
  }

  return {
    orderId: order.id,
    orderNo: order.orderNo,
    userId: order.userId,
    farmId: order.farmId,
    status: order.status,
    placedAt: order.placedAt,
    currency: order.currency,
    billing: {
      name: billing.name ?? '',
      gstin: billing.gstin ?? null,
      placeOfSupply: billing.placeOfSupply ?? '',
    },
    deliveryAddress: (order.deliveryAddress ?? {}) as Record<string, unknown>,
    lines,
    freight,
    payment: { method: paymentMethod, paidAt: order.paidAt },
  };
}
