import { createRequire } from 'node:module';

import PDFDocument from 'pdfkit';

/**
 * Wallet / Points statement PDF (A4, pdfkit). DejaVu Sans is embedded (subset) because it has
 * the ₹ sign; the standard PDF fonts do not. Only ids and amounts — no customer PII.
 */
const require = createRequire(import.meta.url);
const FONT = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const FONT_BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');

const M = 36;
const INK = '#111827';
const MUTED = '#6b7280';
const GREEN = '#047857';
const RED = '#b91c1c';

export interface StatementRow {
  at: Date;
  title: string;
  subtitle: string | null;
  reference: string;
  /** Signed: paise (WALLET) or points (POINTS). */
  amount: bigint;
  /** Balance after (paise or available points). */
  balance: bigint | null;
}

export interface StatementData {
  ledger: 'WALLET' | 'POINTS';
  userId: string;
  /** Inclusive start / exclusive end. */
  from: Date;
  to: Date;
  opening: bigint;
  closing: bigint;
  rows: StatementRow[];
  generatedAt: Date;
}

const IST = 'Asia/Kolkata';
const dateTime = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const dateOnly = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

/** 1,24,892.65 (Indian grouping) from integer paise — exact, no floating point. */
export const inr = (paise: bigint): string => {
  const neg = paise < 0n;
  const abs = neg ? -paise : paise;
  const whole = (abs / 100n).toString();
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = rest === '' ? last3 : `${rest},${last3}`;
  return `${neg ? '-' : ''}${grouped}.${(abs % 100n).toString().padStart(2, '0')}`;
};

/** 18,420 (Indian grouping) points. */
export const pts = (n: bigint): string => inr(n * 100n).slice(0, -3);

export function renderStatementPdf(s: StatementData): Promise<Buffer> {
  const wallet = s.ledger === 'WALLET';
  const doc = new PDFDocument({
    size: 'A4',
    margin: M,
    bufferPages: true,
    info: {
      Title: wallet ? 'FarmX Wallet Statement' : 'FarmX Reward Points Statement',
      Author: 'FarmX',
      Creator: 'FarmX',
      Producer: 'FarmX',
      CreationDate: s.generatedAt,
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

  const W = doc.page.width - 2 * M;
  const text = (
    v: string,
    x: number,
    y: number,
    o: PDFKit.Mixins.TextOptions & { size?: number; bold?: boolean; color?: string } = {},
  ) => {
    doc
      .font(o.bold === true ? 'bold' : 'body')
      .fontSize(o.size ?? 8)
      .fillColor(o.color ?? INK)
      .text(v, x, y, { lineBreak: false, ...o });
  };
  const money = (v: bigint) => (wallet ? `₹${inr(v)}` : `${pts(v)} pts`);
  const lastDay = new Date(s.to.getTime() - 1);

  // ── Header ──
  text(wallet ? 'FarmX Wallet Statement' : 'FarmX Reward Points Statement', M, M, {
    size: 16,
    bold: true,
  });
  text(`Customer ID: ${s.userId}`, M, M + 24, { color: MUTED });
  text(`Period: ${dateOnly.format(s.from)} – ${dateOnly.format(lastDay)} (IST)`, M, M + 36, {
    color: MUTED,
  });
  text(`Generated: ${dateTime.format(s.generatedAt)} IST`, M, M + 48, { color: MUTED });
  text(`Opening ${wallet ? 'balance' : 'points'}: ${money(s.opening)}`, M + W / 2, M + 24, {
    width: W / 2,
    align: 'right',
    bold: true,
  });
  text(`Closing ${wallet ? 'balance' : 'points'}: ${money(s.closing)}`, M + W / 2, M + 38, {
    width: W / 2,
    align: 'right',
    bold: true,
  });

  // ── Table ──
  const cols = wallet
    ? [
        { h: 'Date (IST)', w: 0.18 },
        { h: 'Description', w: 0.29 },
        { h: 'Reference', w: 0.2 },
        { h: 'Credit (₹)', w: 0.11, right: true },
        { h: 'Debit (₹)', w: 0.1, right: true },
        { h: 'Balance (₹)', w: 0.12, right: true },
      ]
    : [
        { h: 'Date (IST)', w: 0.18 },
        { h: 'Description', w: 0.38 },
        { h: 'Reference', w: 0.2 },
        { h: 'Points', w: 0.12, right: true },
        { h: 'Available', w: 0.12, right: true },
      ];
  const xs = cols.reduce<number[]>(
    (acc, c, i) => [...acc, (acc[i - 1] ?? M) + (i === 0 ? 0 : (cols[i - 1]?.w ?? 0) * W)],
    [],
  );
  const header = (y: number) => {
    doc.rect(M, y - 3, W, 16).fill('#f3f4f6');
    cols.forEach((c, i) => {
      text(c.h, (xs[i] ?? M) + 3, y + 1, {
        bold: true,
        width: c.w * W - 6,
        align: c.right === true ? 'right' : 'left',
      });
    });
    return y + 18;
  };
  let y = header(M + 72);
  const bottom = doc.page.height - M - 20;

  if (s.rows.length === 0) text('No transactions in this period.', M, y + 4, { color: MUTED });
  for (const r of s.rows) {
    if (y + 22 > bottom) {
      doc.addPage();
      y = header(M);
    }
    const cells = wallet
      ? [
          dateTime.format(r.at),
          r.subtitle === null ? r.title : `${r.title} · ${r.subtitle}`,
          r.reference,
          r.amount > 0n ? inr(r.amount) : '',
          r.amount < 0n ? inr(-r.amount) : '',
          r.balance === null ? '' : inr(r.balance),
        ]
      : [
          dateTime.format(r.at),
          r.subtitle === null ? r.title : `${r.title} · ${r.subtitle}`,
          r.reference,
          `${r.amount > 0n ? '+' : ''}${pts(r.amount)}`,
          r.balance === null ? '' : pts(r.balance),
        ];
    cells.forEach((v, i) => {
      const c = cols[i];
      if (c === undefined) return;
      const color =
        (wallet && i === 3) || (!wallet && i === 3 && r.amount > 0n)
          ? GREEN
          : (wallet && i === 4) || (!wallet && i === 3 && r.amount < 0n)
            ? RED
            : INK;
      text(v, (xs[i] ?? M) + 3, y, {
        width: c.w * W - 6,
        align: c.right === true ? 'right' : 'left',
        color,
        ellipsis: true,
        height: 20,
        lineBreak: i === 1,
      });
    });
    y += 22;
    doc
      .moveTo(M, y - 4)
      .lineTo(M + W, y - 4)
      .lineWidth(0.3)
      .strokeColor('#e5e7eb')
      .stroke();
  }

  // ── Footer on every page ──
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    // Writing inside the bottom margin must not start a new page.
    doc.page.margins.bottom = 0;
    text(
      `Closed-loop FarmX wallet · amounts in INR · page ${String(i + 1)} of ${String(range.count)}`,
      M,
      doc.page.height - M - 8,
      { color: MUTED, size: 7, width: W, align: 'center' },
    );
  }
  doc.end();
  return done;
}
