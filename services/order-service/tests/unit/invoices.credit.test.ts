import { describe, expect, it } from 'vitest';

import {
  buildCreditNote,
  creditNoteDeadline,
  cumulative,
  linesHash,
} from '../../src/features/invoices/invoices.gst.js';
import type { ActiveInvoice, InvoiceLineRow } from '../../src/features/invoices/invoices.types.js';
import { csvRow } from '../../src/features/invoices/invoices.views.js';

/** Deterministic PRNG (mulberry32): every random case is reproducible from its seed. */
const rng = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const line = (
  lineNo: number,
  qty: number,
  taxable: bigint,
  rateBp: number,
  intra = true,
  kind: 'GOODS' | 'FREIGHT' = 'GOODS',
): InvoiceLineRow => {
  const tax = (taxable * BigInt(rateBp) + 5000n) / 10000n;
  const cgst = intra ? tax / 2n : 0n;
  const sgst = intra ? tax - tax / 2n : 0n;
  const igst = intra ? 0n : tax;
  return {
    lineNo,
    kind,
    orderLineNo: kind === 'FREIGHT' ? null : lineNo * 10,
    variantId: null,
    sku: kind === 'FREIGHT' ? null : `SKU-${String(lineNo)}`,
    description: kind === 'FREIGHT' ? 'Freight' : `Item ${String(lineNo)}`,
    hsnSac: kind === 'FREIGHT' ? '996511' : '30023000',
    qty,
    unitPricePaise: taxable / BigInt(qty),
    grossPaise: taxable + 1234n,
    discountPaise: 1234n,
    taxablePaise: taxable,
    gstRateBp: rateBp,
    cgstPaise: cgst,
    sgstPaise: sgst,
    igstPaise: igst,
    totalPaise: taxable + cgst + sgst + igst,
  };
};

const invoice = (
  lines: InvoiceLineRow[],
  credited = new Map<number, number>(),
  section = 'B2CS',
  buyerGstin: string | null = null,
) => ({
  lines,
  creditedQty: credited,
  buyerGstin,
  snapshot: { document: { gstr1Section: section } } as unknown as ActiveInvoice['snapshot'],
});

const COMPONENTS = ['grossPaise', 'taxablePaise', 'cgstPaise', 'sgstPaise', 'igstPaise'] as const;

describe('linesHash (shared with warehouse-service: same test vector there)', () => {
  it('is order-independent, ignores qty 0 and matches the fixed vector', () => {
    expect(
      linesHash([
        { lineNo: 2, qty: 5 },
        { lineNo: 1, qty: 3 },
        { lineNo: 7, qty: 0 },
      ]),
    ).toBe('44f745929bc6fe3b');
    expect(
      linesHash([
        { lineNo: 1, qty: 3 },
        { lineNo: 2, qty: 5 },
      ]),
    ).toBe('44f745929bc6fe3b');
    expect(linesHash([{ lineNo: 1, qty: 4 }])).not.toBe(linesHash([{ lineNo: 1, qty: 3 }]));
  });
});

describe('buildCreditNote: financial accuracy (paise, cumulative, no drift)', () => {
  it('property: any sequence of partial credits sums to the invoice line EXACTLY (500 cases)', () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const r = rng(seed);
      const qty = 1 + Math.floor(r() * 97);
      const taxable = BigInt(1 + Math.floor(r() * 9_999_999));
      const rate = [0, 500, 1200, 1800, 2800][Math.floor(r() * 5)] ?? 1800;
      const inv = line(1, qty, taxable, rate, r() < 0.5);
      const credited = new Map<number, number>();
      const sums = Object.fromEntries(COMPONENTS.map((c) => [c, 0n])) as Record<
        (typeof COMPONENTS)[number],
        bigint
      >;
      let done = 0;
      while (done < qty) {
        const k = 1 + Math.floor(r() * (qty - done));
        const { draft, issues } = buildCreditNote(invoice([inv], credited), [
          { orderLineNo: 10, qty: k },
        ]);
        expect(issues).toEqual([]);
        const l = draft?.lines[0];
        if (l === undefined) throw new Error(`seed ${String(seed)}: no line`);
        for (const c of COMPONENTS) {
          expect(l[c] >= 0n).toBe(true);
          sums[c] += l[c];
          // Never more than invoiced at any step.
          expect(sums[c] <= inv[c]).toBe(true);
        }
        expect(l.totalPaise).toBe(l.taxablePaise + l.cgstPaise + l.sgstPaise + l.igstPaise);
        done += k;
        credited.set(1, done);
        expect(draft?.fullyCredited).toBe(done === qty);
      }
      for (const c of COMPONENTS) expect(sums[c]).toBe(inv[c]);
    }
  });

  it('a partial credit equals the same cumulative share the invoice used', () => {
    const inv = line(1, 3, 10_000n, 1800);
    const { draft } = buildCreditNote(invoice([inv]), [{ orderLineNo: 10, qty: 1 }]);
    expect(draft?.lines[0]?.taxablePaise).toBe(cumulative(10_000n, 1, 3));
    expect(draft?.totals.grandTotalPaise).toBe(draft?.lines[0]?.totalPaise);
    expect(draft?.fullyCredited).toBe(false);
  });

  it("'ALL' credits every open unit AND freight; a partial credit never touches freight", () => {
    const goods = line(1, 4, 40_000n, 1800);
    const freight = line(2, 1, 5_000n, 1800, true, 'FREIGHT');
    const partial = buildCreditNote(invoice([goods, freight]), [{ orderLineNo: 10, qty: 4 }]);
    expect(partial.draft?.lines.map((l) => l.kind)).toEqual(['GOODS']);
    expect(partial.draft?.fullyCredited).toBe(false); // freight still billed

    const all = buildCreditNote(invoice([goods, freight], new Map([[1, 1]])), 'ALL');
    expect(all.draft?.lines.map((l) => [l.kind, l.qty])).toEqual([
      ['GOODS', 3],
      ['FREIGHT', 1],
    ]);
    expect(all.draft?.fullyCredited).toBe(true);
    const grand = all.draft?.totals.grandTotalPaise ?? 0n;
    const oneUnit = buildCreditNote(invoice([goods]), [{ orderLineNo: 10, qty: 1 }]).draft;
    expect(grand + (oneUnit?.totals.grandTotalPaise ?? 0n)).toBe(
      goods.totalPaise + freight.totalPaise,
    );
  });

  it('refuses over-credit, unknown lines, duplicates and an already credited invoice', () => {
    const inv = line(1, 2, 2_000n, 1800);
    const over = buildCreditNote(invoice([inv], new Map([[1, 1]])), [{ orderLineNo: 10, qty: 2 }]);
    expect(over.draft).toBeNull();
    expect(over.issues[0]?.message).toMatch(/1\.\.1/);
    expect(buildCreditNote(invoice([inv]), [{ orderLineNo: 99, qty: 1 }]).draft).toBeNull();
    expect(
      buildCreditNote(invoice([inv]), [
        { orderLineNo: 10, qty: 1 },
        { orderLineNo: 10, qty: 1 },
      ]).issues.some((i) => i.message.includes('twice')),
    ).toBe(true);
    expect(buildCreditNote(invoice([inv]), []).draft).toBeNull();
    expect(buildCreditNote(invoice([inv], new Map([[1, 2]])), 'ALL').draft).toBeNull();
  });

  it('inter-state credit keeps IGST only (split copied from the invoice line)', () => {
    const inv = line(1, 5, 50_000n, 1200, false);
    const { draft } = buildCreditNote(invoice([inv]), [{ orderLineNo: 10, qty: 2 }]);
    expect(draft?.totals.cgstPaise).toBe(0n);
    expect(draft?.totals.sgstPaise).toBe(0n);
    expect(draft?.totals.igstPaise).toBe(cumulative(inv.igstPaise, 2, 5));
  });

  it('GSTR-1 section: CDNR (registered) · CDNUR (original B2CL) · B2CS (net adjustment)', () => {
    const inv = line(1, 1, 1_000n, 1800);
    const req = [{ orderLineNo: 10, qty: 1 }];
    const b2b = invoice([inv], new Map(), 'B2B', '37AABCF1234A1Z5');
    expect(buildCreditNote(b2b, req).draft?.gstr1Section).toBe('CDNR');
    expect(buildCreditNote(invoice([inv], new Map(), 'B2CL'), req).draft?.gstr1Section).toBe(
      'CDNUR',
    );
    expect(buildCreditNote(invoice([inv]), req).draft?.gstr1Section).toBe('B2CS');
  });
});

describe('creditNoteDeadline (CGST s.34(2))', () => {
  it('30 November after the financial year, end of day IST', () => {
    expect(creditNoteDeadline('2627').toISOString()).toBe('2027-11-30T18:29:59.999Z');
    expect(creditNoteDeadline('2526').toISOString()).toBe('2026-11-30T18:29:59.999Z');
  });
});

describe('GST register CSV', () => {
  it('quotes RFC 4180 and neutralises formula injection (numbers stay numbers)', () => {
    expect(csvRow(['a', 'b,c', 'say "hi"'])).toBe('a,"b,c","say ""hi"""\r\n');
    expect(csvRow(['=HYPERLINK("x")', '+1', '-5.00', '@x'])).toBe(
      `"'=HYPERLINK(""x"")",'+1,-5.00,'@x\r\n`,
    );
  });
});
