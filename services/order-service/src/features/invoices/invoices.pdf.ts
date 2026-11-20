import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

import PDFDocument from 'pdfkit';

import type { InvoiceSnapshot, SnapshotLine } from './invoices.types.js';

/**
 * A4 GST document from the IMMUTABLE snapshot only (never the live order). Deterministic: the PDF
 * dates are the issue time, so the same snapshot always renders the same bytes (stable SHA-256).
 * DejaVu Sans is embedded (subset) because it has the ₹ sign; the standard PDF fonts do not.
 */

const require = createRequire(import.meta.url);
const FONT = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const FONT_BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');

const A4 = { width: 595.28, height: 841.89 };
const M = 36;
const WIDTH = A4.width - 2 * M;
const BOTTOM = A4.height - M - 28;
const INK = '#1f2937';
const MUTED = '#6b7280';
const RULE = '#d1d5db';
const SHADE = '#f3f4f6';

const TITLES: Record<InvoiceSnapshot['document']['docType'], string> = {
  TAX_INVOICE: 'TAX INVOICE',
  BILL_OF_SUPPLY: 'BILL OF SUPPLY',
  CREDIT_NOTE: 'CREDIT NOTE',
};

const rupees = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const money = (paise: number) => `₹${rupees.format(paise / 100)}`;
const percent = (bp: number) => `${String(bp / 100)}%`;
const day = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' });
const date = (iso: string | null) => (iso === null ? '—' : day.format(new Date(iso)));

/** Address snapshot (user-service shape) → printable lines. */
const addressLines = (a: Record<string, unknown>, stateName: string | null): string[] => {
  const s = (k: string) => (typeof a[k] === 'string' && a[k] !== '' ? a[k] : null);
  const lines = [
    s('contactName'),
    [s('line1'), s('line2')].filter(Boolean).join(', '),
    [s('landmark'), s('village'), s('mandal')].filter(Boolean).join(', '),
    [s('district'), stateName, s('pinCode')].filter(Boolean).join(', '),
  ].filter((l): l is string => l !== null && l !== '');
  return lines.length > 0 ? lines : [s('formatted') ?? ''];
};

interface Column {
  label: string;
  width: number;
  align: 'left' | 'right' | 'center';
  cell: (l: SnapshotLine, i: number) => string;
}

export interface RenderOptions {
  logoPath?: string | undefined;
}

export function renderInvoicePdf(
  snap: InvoiceSnapshot,
  options: RenderOptions = {},
): Promise<Buffer> {
  const issuedAt = new Date(snap.document.issuedAt);
  const doc = new PDFDocument({
    size: 'A4',
    margin: M,
    bufferPages: true,
    info: {
      Title: `${TITLES[snap.document.docType]} ${snap.document.docNo}`,
      Author: snap.seller.legalName ?? 'FarmX',
      Subject: `Order ${snap.order.orderNo}`,
      Creator: 'FarmX',
      Producer: 'FarmX',
      CreationDate: issuedAt,
      ModDate: issuedAt,
    },
  });
  doc.registerFont('body', FONT);
  doc.registerFont('bold', FONT_BOLD);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);
  });

  const text = (
    s: string,
    x: number,
    y: number,
    o: PDFKit.Mixins.TextOptions & { size?: number; bold?: boolean; color?: string } = {},
  ) => {
    doc
      .font(o.bold === true ? 'bold' : 'body')
      .fontSize(o.size ?? 8)
      .fillColor(o.color ?? INK)
      .text(s, x, y, { lineBreak: true, ...o });
  };

  // ── Header: seller (left) · title (right) ──
  let y = M;
  if (options.logoPath !== undefined && existsSync(options.logoPath)) {
    doc.image(options.logoPath, M, y, { fit: [140, 40] });
    y += 44;
  } else {
    text(snap.seller.legalName ?? '', M, y, { size: 14, bold: true, width: 330 });
    y = doc.y + 2;
  }
  text(snap.seller.address ?? '', M, y, { width: 330, color: MUTED });
  text(
    `GSTIN: ${snap.seller.gstin ?? '—'}   State: ${snap.seller.stateName ?? ''} (${snap.seller.stateCode})`,
    M,
    doc.y + 2,
    { width: 330 },
  );
  text(TITLES[snap.document.docType], M + 330, M, {
    size: 16,
    bold: true,
    width: WIDTH - 330,
    align: 'right',
  });
  text('Original for Recipient', M + 330, M + 22, {
    width: WIDTH - 330,
    align: 'right',
    color: MUTED,
  });
  y = Math.max(doc.y, M + 60) + 10;
  doc
    .moveTo(M, y)
    .lineTo(M + WIDTH, y)
    .strokeColor(RULE)
    .lineWidth(0.8)
    .stroke();

  // ── Document facts (two columns) ──
  y += 8;
  const isCredit = snap.document.docType === 'CREDIT_NOTE';
  const left: [string, string][] = [
    [isCredit ? 'Credit note no.' : 'Invoice no.', snap.document.docNo],
    [isCredit ? 'Credit note date' : 'Invoice date', date(snap.document.issuedAt)],
    ...(snap.original === undefined
      ? []
      : ([['Against invoice', `${snap.original.docNo} (${date(snap.original.issuedAt)})`]] as [
          string,
          string,
        ][])),
    ['Order no.', snap.order.orderNo],
    ['Order date', date(snap.order.placedAt)],
  ];
  const right: [string, string][] = [
    ['Place of supply', `${snap.buyer.placeOfSupplyName ?? ''} (${snap.buyer.placeOfSupply})`],
    ['Supply type', snap.document.supplyType === 'INTRA' ? 'Intra-state' : 'Inter-state'],
    ['Reverse charge', snap.document.reverseCharge ? 'Yes' : 'No'],
    [
      'Payment',
      `${snap.payment.method === null ? 'Prepaid' : snap.payment.method.toUpperCase()} · ${snap.payment.status}`,
    ],
  ];
  const facts = (rows: [string, string][], x: number) => {
    rows.forEach(([k, v], i) => {
      text(k, x, y + i * 12, { color: MUTED, width: 90 });
      text(v, x + 90, y + i * 12, { bold: true, width: WIDTH / 2 - 100 });
    });
  };
  facts(left, M);
  facts(right, M + WIDTH / 2);
  y += Math.max(left.length, right.length) * 12 + 8;

  // ── Bill to / Ship to ──
  const party = (
    title: string,
    x: number,
    name: string,
    gstin: string | null,
    addr: Record<string, unknown>,
  ) => {
    text(title, x, y, { bold: true, color: MUTED });
    text(name, x, y + 11, { bold: true, width: WIDTH / 2 - 10 });
    let py = doc.y;
    if (gstin !== null) {
      text(`GSTIN: ${gstin}`, x, py, { width: WIDTH / 2 - 10 });
      py = doc.y;
    }
    text(addressLines(addr, snap.buyer.placeOfSupplyName).join('\n'), x, py, {
      width: WIDTH / 2 - 10,
    });
    return doc.y;
  };
  const end1 = party('BILL TO', M, snap.buyer.name, snap.buyer.gstin, snap.buyer.billTo);
  const end2 = party('SHIP TO', M + WIDTH / 2, snap.buyer.name, null, snap.buyer.shipTo);
  y = Math.max(end1, end2) + 10;

  // ── Line table ──
  const intra = snap.document.supplyType === 'INTRA';
  const columns: Column[] = [
    { label: '#', width: 16, align: 'left', cell: (_l, i) => String(i + 1) },
    {
      label: 'Description',
      width: intra ? 120 : 158,
      align: 'left',
      cell: (l) =>
        `${l.description}\n${[l.sku, `GST ${percent(l.gstRateBp)}`].filter(Boolean).join(' · ')}`,
    },
    { label: 'HSN/SAC', width: 52, align: 'left', cell: (l) => l.hsnSac },
    { label: 'Qty', width: 26, align: 'right', cell: (l) => String(l.qty) },
    { label: 'Rate', width: 54, align: 'right', cell: (l) => money(l.unitPricePaise) },
    { label: 'Discount', width: 48, align: 'right', cell: (l) => money(l.discountPaise) },
    { label: 'Taxable', width: 58, align: 'right', cell: (l) => money(l.taxablePaise) },
    ...(intra
      ? [
          {
            label: 'CGST',
            width: 48,
            align: 'right',
            cell: (l: SnapshotLine) => money(l.cgstPaise),
          } as Column,
          {
            label: 'SGST',
            width: 48,
            align: 'right',
            cell: (l: SnapshotLine) => money(l.sgstPaise),
          } as Column,
        ]
      : [
          {
            label: 'IGST',
            width: 58,
            align: 'right',
            cell: (l: SnapshotLine) => money(l.igstPaise),
          } as Column,
        ]),
    { label: 'Total', width: 53, align: 'right', cell: (l) => money(l.totalPaise) },
  ];
  const header = () => {
    doc.rect(M, y, WIDTH, 16).fill(SHADE);
    let x = M;
    for (const c of columns) {
      text(c.label, x + 2, y + 4, { bold: true, width: c.width - 4, align: c.align, size: 7.5 });
      x += c.width;
    }
    y += 18;
  };
  header();
  snap.lines.forEach((line, i) => {
    const cells = columns.map((c) => c.cell(line, i));
    doc.font('body').fontSize(8);
    const h =
      Math.max(
        ...cells.map((s, j) => doc.heightOfString(s, { width: (columns[j]?.width ?? 0) - 4 })),
      ) + 6;
    if (y + h > BOTTOM) {
      doc.addPage();
      y = M;
      header();
    }
    let x = M;
    cells.forEach((s, j) => {
      const c = columns[j];
      if (c === undefined) return;
      text(s, x + 2, y + 3, { width: c.width - 4, align: c.align });
      x += c.width;
    });
    y += h;
    doc
      .moveTo(M, y)
      .lineTo(M + WIDTH, y)
      .strokeColor(RULE)
      .lineWidth(0.4)
      .stroke();
  });

  // ── Totals (right) + amount in words (left) ──
  const t = snap.totals;
  const totals: [string, string, boolean][] = [
    ['Taxable value', money(t.taxablePaise), false],
    ...(intra
      ? ([
          ['CGST', money(t.cgstPaise), false],
          ['SGST', money(t.sgstPaise), false],
        ] as [string, string, boolean][])
      : ([['IGST', money(t.igstPaise), false]] as [string, string, boolean][])),
    ...(t.roundOffPaise === 0
      ? []
      : ([['Round off', money(t.roundOffPaise), false]] as [string, string, boolean][])),
    [isCredit ? 'Total credit' : 'Grand total', money(t.grandTotalPaise), true],
  ];
  if (y + totals.length * 14 + 50 > BOTTOM) {
    doc.addPage();
    y = M;
  }
  y += 8;
  totals.forEach(([k, v, strong], i) => {
    const ty = y + i * 14;
    text(k, M + WIDTH - 220, ty, { width: 120, bold: strong, size: strong ? 10 : 8 });
    text(v, M + WIDTH - 100, ty, {
      width: 100,
      align: 'right',
      bold: strong,
      size: strong ? 10 : 8,
    });
  });
  text('Amount in words', M, y, { color: MUTED });
  text(snap.amountInWords, M, y + 11, { bold: true, width: WIDTH - 240 });
  y += totals.length * 14 + 14;

  // ── HSN / SAC summary ──
  const hsnCols: [string, number, (h: InvoiceSnapshot['hsnSummary'][number]) => string][] = [
    ['HSN/SAC', 90, (h) => h.hsnSac],
    ['Rate', 50, (h) => percent(h.gstRateBp)],
    ['Taxable value', 110, (h) => money(h.taxablePaise)],
    ...(intra
      ? ([
          ['CGST', 90, (h) => money(h.cgstPaise)],
          ['SGST', 90, (h) => money(h.sgstPaise)],
        ] as [string, number, (h: InvoiceSnapshot['hsnSummary'][number]) => string][])
      : ([['IGST', 180, (h) => money(h.igstPaise)]] as [
          string,
          number,
          (h: InvoiceSnapshot['hsnSummary'][number]) => string,
        ][])),
    ['Total tax', WIDTH - 430, (h) => money(h.cgstPaise + h.sgstPaise + h.igstPaise)],
  ];
  if (y + 18 + snap.hsnSummary.length * 13 + 60 > BOTTOM) {
    doc.addPage();
    y = M;
  }
  doc.rect(M, y, WIDTH, 15).fill(SHADE);
  let hx = M;
  for (const [label, w] of hsnCols) {
    text(label, hx + 2, y + 4, { bold: true, width: w - 4, size: 7.5 });
    hx += w;
  }
  y += 17;
  for (const h of snap.hsnSummary) {
    hx = M;
    for (const [, w, cell] of hsnCols) {
      text(cell(h), hx + 2, y, { width: w - 4 });
      hx += w;
    }
    y += 13;
  }

  // ── Legal notes ──
  y += 10;
  const notes = [
    snap.document.docType === 'BILL_OF_SUPPLY'
      ? 'Bill of supply: exempt / nil-rated supply; no GST is charged.'
      : `Tax is not payable on reverse charge basis.`,
    isCredit ? 'This credit note reduces the tax and value of the invoice stated above.' : null,
    'This is a computer-generated document and does not require a signature.',
    `Amounts in Indian Rupees (${snap.document.currency}).`,
  ].filter((n): n is string => n !== null);
  text(notes.join('\n'), M, y, { width: WIDTH, color: MUTED, size: 7.5 });
  text(`For ${snap.seller.legalName ?? ''}`, M + WIDTH - 200, doc.y + 12, {
    width: 200,
    align: 'right',
    bold: true,
  });

  // ── Footer on every page ──
  const range = doc.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p += 1) {
    doc.switchToPage(p);
    text(
      `${snap.document.docNo} · Page ${String(p + 1)} of ${String(range.count)}`,
      M,
      A4.height - M - 10,
      { width: WIDTH, align: 'center', color: MUTED, size: 7, lineBreak: false },
    );
  }
  doc.end();
  return done;
}
