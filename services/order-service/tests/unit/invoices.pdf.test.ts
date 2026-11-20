import { createHash } from 'node:crypto';

import { extractText, getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';

import { renderInvoicePdf } from '../../src/features/invoices/invoices.pdf.js';
import type { InvoiceSnapshot, SnapshotLine } from '../../src/features/invoices/invoices.types.js';

const line = (n: number, over: Partial<SnapshotLine> = {}): SnapshotLine => ({
  lineNo: n,
  kind: 'GOODS',
  orderLineNo: n,
  sku: `IT-SKU-${String(n)}`,
  description: `Ranikhet (LaSota) vaccine, 1000 doses, cold chain ${String(n)}`,
  hsnSac: '30023000',
  qty: 2,
  unitPricePaise: 25_000,
  grossPaise: 50_000,
  discountPaise: 5_000,
  taxablePaise: 45_000,
  gstRateBp: 1200,
  cgstPaise: 2_700,
  sgstPaise: 2_700,
  igstPaise: 0,
  totalPaise: 50_400,
  ...over,
});

const snapshot = (
  lines: SnapshotLine[],
  over: Partial<InvoiceSnapshot['document']> = {},
): InvoiceSnapshot => {
  const sum = (k: keyof SnapshotLine) => lines.reduce((a, l) => a + (l[k] as number), 0);
  return {
    version: 1,
    document: {
      id: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d0001',
      docType: 'TAX_INVOICE',
      docNo: 'FX/2627/0000123',
      fy: '2627',
      issuedAt: '2026-11-19T06:30:00.000Z',
      supplyType: 'INTRA',
      reverseCharge: false,
      gstr1Section: 'B2CS',
      currency: 'INR',
      ...over,
    },
    seller: {
      legalName: 'FarmX Test Seller Pvt Ltd',
      gstin: '37AABCF1234A1Z5',
      address: 'Plot 12, Test Estate, Nuzvid, Andhra Pradesh 521201',
      stateCode: '37',
      stateName: 'Andhra Pradesh',
    },
    buyer: {
      name: 'Sri Lakshmi Poultry',
      gstin: null,
      placeOfSupply: '37',
      placeOfSupplyName: 'Andhra Pradesh',
      billTo: {
        contactName: 'R. Rao',
        line1: 'Plot 1',
        district: 'West Godavari',
        pinCode: '534211',
      },
      shipTo: {
        contactName: 'R. Rao',
        line1: 'Plot 1',
        district: 'West Godavari',
        pinCode: '534211',
      },
    },
    order: {
      orderId: 'o1',
      orderNo: 'ORD-26-0091842',
      placedAt: '2026-11-18T10:00:00.000Z',
      shipmentId: 's1',
    },
    lines,
    hsnSummary: [
      {
        hsnSac: '30023000',
        gstRateBp: 1200,
        qty: sum('qty'),
        taxablePaise: sum('taxablePaise'),
        cgstPaise: sum('cgstPaise'),
        sgstPaise: sum('sgstPaise'),
        igstPaise: sum('igstPaise'),
      },
    ],
    totals: {
      taxablePaise: sum('taxablePaise'),
      cgstPaise: sum('cgstPaise'),
      sgstPaise: sum('sgstPaise'),
      igstPaise: sum('igstPaise'),
      totalTaxPaise: sum('cgstPaise') + sum('sgstPaise') + sum('igstPaise'),
      roundOffPaise: 0,
      grandTotalPaise: sum('totalPaise'),
    },
    amountInWords: 'Rupees Five Hundred Four Only',
    payment: { method: 'upi', paidAt: '2026-11-18T10:05:00.000Z', status: 'PAID' },
  };
};

const textOf = async (pdf: Buffer) => {
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(pdf)), {
    mergePages: true,
  });
  return text;
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('invoice PDF', () => {
  it('prints every required GST field (incl. ₹ and amount in words)', async () => {
    const pdf = await renderInvoicePdf(snapshot([line(1)]));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = await textOf(pdf);
    for (const needle of [
      'TAX INVOICE',
      'FarmX Test Seller Pvt Ltd',
      '37AABCF1234A1Z5',
      'FX/2627/0000123',
      'ORD-26-0091842',
      'Sri Lakshmi Poultry',
      'Andhra Pradesh (37)',
      '30023000',
      '₹504.00',
      'CGST',
      'SGST',
      'Rupees Five Hundred Four Only',
      'reverse charge',
      'computer-generated',
    ])
      expect(text, needle).toContain(needle);
  });

  it('is deterministic: the same snapshot renders the same bytes', async () => {
    const s = snapshot([line(1), line(2)]);
    expect(sha(await renderInvoicePdf(s))).toBe(sha(await renderInvoicePdf(s)));
  });

  it('long invoices paginate with "Page x of y"; inter-state shows IGST only', async () => {
    const lines = Array.from({ length: 45 }, (_, i) =>
      line(i + 1, { cgstPaise: 0, sgstPaise: 0, igstPaise: 5_400 }),
    );
    const pdf = await renderInvoicePdf(snapshot(lines, { supplyType: 'INTER' }));
    const text = await textOf(pdf);
    expect(text).toMatch(/Page 1 of [2-9]/);
    expect(text).toContain('IGST');
    expect(text).not.toContain('SGST');
  });

  it('bill of supply and credit note wording', async () => {
    const bos = await textOf(
      await renderInvoicePdf(
        snapshot([line(1, { gstRateBp: 0, cgstPaise: 0, sgstPaise: 0, totalPaise: 45_000 })], {
          docType: 'BILL_OF_SUPPLY',
        }),
      ),
    );
    expect(bos).toContain('BILL OF SUPPLY');
    expect(bos).toContain('no GST is charged');
    const cn = {
      ...snapshot([line(1)], { docType: 'CREDIT_NOTE', docNo: 'CN/2627/0000007' }),
      original: { docNo: 'FX/2627/0000123', issuedAt: '2026-11-19T06:30:00.000Z' },
    };
    const text = await textOf(await renderInvoicePdf(cn));
    expect(text).toContain('CREDIT NOTE');
    expect(text).toContain('FX/2627/0000123');
    expect(text).toContain('Total credit');
  });
});
