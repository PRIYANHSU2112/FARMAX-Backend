import { describe, expect, it } from 'vitest';

import { buildInvoice, cumulative } from '../../src/features/invoices/invoices.gst.js';
import {
  financialYear,
  formatDocNo,
  gstinCheckChar,
  isValidGstin,
  isValidHsn,
} from '../../src/features/invoices/invoices.tax-ids.js';
import type {
  InvoiceOrderFacts,
  OrderLineFacts,
  SellerInfo,
} from '../../src/features/invoices/invoices.types.js';
import { amountInWords } from '../../src/features/invoices/invoices.words.js';

/** A syntactically valid GSTIN for a state (test fixture: checksum computed, not a real entity). */
const gstin = (state: string, pan = 'AABCF1234A') => {
  const first14 = `${state}${pan}1Z`;
  return `${first14}${gstinCheckChar(first14)}`;
};

const SELLER: SellerInfo = {
  gstin: gstin('37'),
  legalName: 'FarmX Agritech Pvt Ltd',
  address: 'Nuzvid, Andhra Pradesh',
  stateCode: '37',
  invoiceSeries: 'FX',
  creditNoteSeries: 'CN',
  b2clThresholdPaise: 10_000_000n,
};

/** GST per line exactly like the pricing engine (half-up per line on the taxable value). */
const line = (
  lineNo: number,
  qty: number,
  unitPaise: bigint,
  discountPaise: bigint,
  rateBp: number,
  inter = false,
): OrderLineFacts => {
  const gross = unitPaise * BigInt(qty);
  const taxable = gross - discountPaise;
  const half = (taxable * BigInt(rateBp) * 2n + 20_000n) / 40_000n;
  const full = (taxable * BigInt(rateBp) * 2n + 10_000n) / 20_000n;
  return {
    lineNo,
    variantId: `v${String(lineNo)}`,
    sku: `SKU-${String(lineNo)}`,
    name: `Item ${String(lineNo)}`,
    hsnCode: '30023000',
    gstRateBp: rateBp,
    qty,
    cancelledQty: 0,
    unitPricePaise: unitPaise,
    grossPaise: gross,
    taxablePaise: taxable,
    cgstPaise: inter ? 0n : half,
    sgstPaise: inter ? 0n : half,
    igstPaise: inter ? full : 0n,
  };
};

const facts = (over: Partial<InvoiceOrderFacts> = {}): InvoiceOrderFacts => ({
  orderId: 'o1',
  orderNo: 'ORD-26-0000001',
  userId: 'u1',
  farmId: 'f1',
  status: 'CONFIRMED',
  placedAt: new Date('2026-11-19T05:00:00Z'),
  currency: 'INR',
  billing: { name: 'Sri Lakshmi Poultry', gstin: null, placeOfSupply: '37' },
  deliveryAddress: { district: 'West Godavari', stateCode: '37' },
  lines: [line(1, 3, 10_000n, 1_000n, 1800), line(2, 1, 25_000n, 0n, 0)],
  freight: null,
  payment: { method: 'upi', paidAt: new Date('2026-11-19T05:05:00Z') },
  ...over,
});
const none = { qtyByLine: new Map<number, number>(), freightInvoiced: false };

describe('GST identifiers and formatting', () => {
  it('validates GSTIN checksum, state and HSN', () => {
    const g = gstin('37');
    expect(isValidGstin(g)).toBe(true);
    const wrong = `${g.slice(0, 14)}${g.endsWith('0') ? '1' : '0'}`;
    expect(isValidGstin(wrong)).toBe(false);
    expect(isValidGstin(gstin('28'))).toBe(false); // 28 is not a GST state code (AP is 37)
    expect(isValidGstin('37AABCF1234A1Y5')).toBe(false); // 14th character must be Z
    expect(['3002', '300230', '30023000'].every(isValidHsn)).toBe(true);
    expect(['30', '30023', '3002300A'].some(isValidHsn)).toBe(false);
  });

  it('financial year switches on 1 April IST; numbers fit 16 characters', () => {
    expect(financialYear(new Date('2026-03-31T18:29:00Z'))).toBe('2526'); // 31 Mar 23:59 IST
    expect(financialYear(new Date('2026-03-31T18:31:00Z'))).toBe('2627'); // 1 Apr 00:01 IST
    expect(financialYear(new Date('2027-01-15T00:00:00Z'))).toBe('2627');
    const no = formatDocNo('FX', '2627', 123);
    expect(no).toBe('FX/2627/0000123');
    expect(formatDocNo('ABC', '2627', 9_999_999)).toBe('ABC/2627/9999999');
    expect(() => formatDocNo('ABCD', '2627', 1)).toThrow(/16 characters/);
  });

  it('amount in words (Indian numbering)', () => {
    expect(amountInWords(2_782_150n)).toBe(
      'Rupees Twenty-Seven Thousand Eight Hundred Twenty-One and Fifty Paise Only',
    );
    expect(amountInWords(1_234_567_800n)).toBe(
      'Rupees One Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred Seventy-Eight Only',
    );
    expect(amountInWords(100n)).toBe('Rupees One Only');
    expect(amountInWords(5n)).toBe('Rupees Zero and Five Paise Only');
  });
});

describe('cumulative allocation (property test)', () => {
  it('any split of any line adds up to the line exactly, never negative', () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let run = 0; run < 2_000; run += 1) {
      const qty = 1 + rand(60);
      const amount = BigInt(rand(50_000_000));
      let invoiced = 0;
      let billed = 0n;
      while (invoiced < qty) {
        const k = 1 + rand(qty - invoiced);
        const part = cumulative(amount, invoiced + k, qty) - cumulative(amount, invoiced, qty);
        expect(part >= 0n).toBe(true);
        billed += part;
        invoiced += k;
      }
      expect(billed).toBe(amount);
    }
  });

  it('half-up: 1 paisa over 3 units → 0, 1, 0', () => {
    expect([1, 2, 3].map((n) => cumulative(1n, n, 3) - cumulative(1n, n - 1, 3))).toEqual([
      0n,
      1n,
      0n,
    ]);
  });
});

describe('buildInvoice', () => {
  it('intra-state B2C: CGST = SGST, totals = Σ lines, words, mixed rates stay a tax invoice', () => {
    const { draft, issues } = buildInvoice(
      facts(),
      none,
      {
        shipmentId: 's1',
        lines: [
          { lineNo: 1, qty: 3 },
          { lineNo: 2, qty: 1 },
        ],
      },
      SELLER,
    );
    expect(issues).toEqual([]);
    expect(draft).toMatchObject({
      docType: 'TAX_INVOICE',
      supplyType: 'INTRA',
      gstr1Section: 'B2CS',
    });
    const [l1] = draft?.lines ?? [];
    expect(l1).toMatchObject({
      grossPaise: 30_000n,
      discountPaise: 1_000n,
      taxablePaise: 29_000n,
      cgstPaise: 2_610n,
      sgstPaise: 2_610n,
      igstPaise: 0n,
      totalPaise: 34_220n,
    });
    expect(draft?.totals).toMatchObject({
      taxablePaise: 54_000n,
      cgstPaise: 2_610n,
      sgstPaise: 2_610n,
      grandTotalPaise: 59_220n,
    });
    expect(draft?.hsnSummary).toHaveLength(2);
    expect(draft?.amountInWords).toBe('Rupees Five Hundred Ninety-Two and Twenty Paise Only');
  });

  it('inter-state: IGST only; B2CL above the threshold; B2B with a buyer GSTIN', () => {
    const big = [line(1, 10, 1_500_000n, 0n, 1800, true)];
    const inter = facts({
      billing: { name: 'Farm', gstin: null, placeOfSupply: '29' },
      lines: big,
    });
    const r1 = buildInvoice(
      inter,
      none,
      { shipmentId: 's', lines: [{ lineNo: 1, qty: 10 }] },
      SELLER,
    );
    expect(r1.draft).toMatchObject({ supplyType: 'INTER', gstr1Section: 'B2CL' });
    expect(r1.draft?.totals).toMatchObject({ cgstPaise: 0n, sgstPaise: 0n, igstPaise: 2_700_000n });
    const b2b = facts({
      billing: { name: 'Farm', gstin: gstin('29'), placeOfSupply: '29' },
      lines: big,
    });
    expect(
      buildInvoice(b2b, none, { shipmentId: 's', lines: [{ lineNo: 1, qty: 10 }] }, SELLER).draft
        ?.gstr1Section,
    ).toBe('B2B');
  });

  it('only 0 % lines → bill of supply', () => {
    const r = buildInvoice(
      facts({ lines: [line(1, 2, 5_000n, 0n, 0)] }),
      none,
      { shipmentId: 's', lines: [{ lineNo: 1, qty: 2 }] },
      SELLER,
    );
    expect(r.draft?.docType).toBe('BILL_OF_SUPPLY');
  });

  it('freight is billed in full on the first invoice only', () => {
    const f = facts({
      freight: {
        sac: '996511',
        gstRateBp: 1800,
        taxablePaise: 49_500n,
        cgstPaise: 4_455n,
        sgstPaise: 4_455n,
        igstPaise: 0n,
      },
    });
    const first = buildInvoice(
      f,
      none,
      { shipmentId: 'a', lines: [{ lineNo: 1, qty: 1 }] },
      SELLER,
    );
    expect(first.draft?.lines.map((l) => l.kind)).toEqual(['GOODS', 'FREIGHT']);
    const second = buildInvoice(
      f,
      { qtyByLine: new Map([[1, 1]]), freightInvoiced: true },
      { shipmentId: 'b', lines: [{ lineNo: 1, qty: 2 }] },
      SELLER,
    );
    expect(second.draft?.lines.map((l) => l.kind)).toEqual(['GOODS']);
  });

  it('rejects over-invoicing, cancelled units, duplicates, wrong status and missing seller', () => {
    const cancelled = facts({ lines: [{ ...line(1, 3, 10_000n, 0n, 1800), cancelledQty: 1 }] });
    const over = buildInvoice(
      cancelled,
      { qtyByLine: new Map([[1, 1]]), freightInvoiced: false },
      { shipmentId: 's', lines: [{ lineNo: 1, qty: 2 }] },
      SELLER,
    );
    expect(over.draft).toBeNull();
    expect(over.issues[0]?.message).toBe('qty must be 1..1 for line 1');

    const dup = buildInvoice(
      facts(),
      none,
      {
        shipmentId: 's',
        lines: [
          { lineNo: 1, qty: 1 },
          { lineNo: 1, qty: 1 },
        ],
      },
      SELLER,
    );
    expect(dup.issues.map((i) => i.message)).toContain('line 1 appears twice');

    const pending = buildInvoice(
      facts({ status: 'PENDING_ADMIN_CONFIRMATION' }),
      none,
      { shipmentId: 's', lines: [{ lineNo: 1, qty: 1 }] },
      SELLER,
    );
    expect(pending.issues[0]?.path).toBe('order.status');

    const noSeller = buildInvoice(
      facts(),
      none,
      { shipmentId: 's', lines: [{ lineNo: 1, qty: 1 }] },
      { ...SELLER, gstin: null },
    );
    expect(noSeller.issues[0]?.path).toBe('seller');

    const wrongState = buildInvoice(
      facts(),
      none,
      { shipmentId: 's', lines: [{ lineNo: 1, qty: 1 }] },
      { ...SELLER, gstin: gstin('36') },
    );
    expect(wrongState.issues[0]?.path).toBe('seller.stateCode');
  });

  it('flags order lines whose tax does not match the supply type', () => {
    const r = buildInvoice(
      facts({ lines: [line(1, 1, 10_000n, 0n, 1800, true)] }),
      none,
      { shipmentId: 's', lines: [{ lineNo: 1, qty: 1 }] },
      SELLER,
    );
    expect(r.issues.map((i) => i.path)).toContain('shipment.lines[0].tax');
  });
});
