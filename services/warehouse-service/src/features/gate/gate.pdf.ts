import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

/**
 * Gate pass (GPI / GPO) and weighment slip PDFs (D-62 W5.07 / W5.09 "Print slip / PDF"). Rendered
 * from IMMUTABLE snapshots after commit (never inside a transaction); the same pass always renders
 * the same content, so the response is cacheable. A5 portrait, standard fonts (no ₹ needed).
 */

const A5 = { width: 419.53, height: 595.28 };
const M = 28;
const WIDTH = A5.width - 2 * M;
const INK = '#111827';
const MUTED = '#6b7280';
const RULE = '#d1d5db';
const BRAND = '#ea580c';

const day = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Kolkata',
});
const when = (iso: unknown) =>
  typeof iso === 'string' && iso !== '' ? day.format(new Date(iso)) : '—';
const text = (v: unknown): string =>
  v === null || v === undefined || v === ''
    ? '—'
    : typeof v === 'number'
      ? v.toLocaleString('en-IN')
      : typeof v === 'string'
        ? v
        : JSON.stringify(v);

const createDoc = (title: string, at: Date) => {
  const doc = new PDFDocument({
    size: 'A5',
    margin: M,
    info: {
      Title: title,
      Author: 'FarmX',
      Creator: 'FarmX',
      Producer: 'FarmX',
      CreationDate: at,
      ModDate: at,
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);
  });
  return { doc, done };
};

const header = (doc: PDFKit.PDFDocument, kicker: string, title: string, sub: string) => {
  doc.font('Helvetica-Bold').fontSize(9).fillColor(BRAND).text(`FarmX / ${kicker}`, M, M);
  doc
    .font('Helvetica-Bold')
    .fontSize(20)
    .fillColor(INK)
    .text(title, M, M + 14);
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(MUTED)
    .text(sub, M, M + 40);
  doc
    .moveTo(M, M + 58)
    .lineTo(M + WIDTH, M + 58)
    .strokeColor(RULE)
    .stroke();
};

/** Two-column "label  value" rows; returns the y after the table. */
const rows = (doc: PDFKit.PDFDocument, y: number, items: readonly [string, unknown][]) => {
  let at = y;
  for (const [label, value] of items) {
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(MUTED)
      .text(label, M, at, { width: WIDTH / 2 });
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(INK)
      .text(text(value), M + WIDTH / 2, at, { width: WIDTH / 2, align: 'right' });
    at += 16;
  }
  return at;
};

export async function renderPassPdf(
  pass: {
    passNo: string;
    type: 'INWARD' | 'OUTWARD';
    status: string;
    issuedAt: Date;
    expiresAt: Date;
  },
  snap: Record<string, unknown>,
  qrToken: string | null,
): Promise<Buffer> {
  const { doc, done } = createDoc(
    `${pass.type === 'INWARD' ? 'Inward' : 'Outward'} gate pass ${pass.passNo}`,
    pass.issuedAt,
  );
  header(
    doc,
    pass.type === 'INWARD' ? 'INWARD GATE PASS' : 'OUTWARD GATE PASS',
    pass.passNo,
    `${text(snap.warehouseName)} · ${when(pass.issuedAt.toISOString())} · ${pass.status}`,
  );
  const items: [string, unknown][] =
    pass.type === 'INWARD'
      ? [
          ['Vehicle number', snap.vehicleDisplay],
          ['Driver', snap.driverName],
          ['Mobile', snap.driverMobileMasked],
          ['Entry time', when(snap.arrivedAt)],
          ['Gross weight', snap.grossKg === null ? null : `${text(snap.grossKg)} kg`],
          ['Assigned bay', snap.bayCode],
          ['Shipment', snap.shipmentNo],
          ['Purchase order', snap.poRef],
          ['Delivery challan', snap.challanNo],
          ['Declared cargo', snap.declaredKg === null ? null : `${text(snap.declaredKg)} kg`],
          ['Verified by', snap.verifiedByLabel],
          ['Receiving status', snap.receivingStatus],
        ]
      : [
          ['Vehicle number', snap.vehicleDisplay],
          ['Driver', snap.driverName],
          ['Shipment', snap.shipmentNo],
          ['Receiving reference', snap.rcvNo],
          ['Gross weight', snap.grossKg === null ? null : `${text(snap.grossKg)} kg`],
          ['Tare weight', snap.tareKg === null ? null : `${text(snap.tareKg)} kg`],
          ['Net cargo', snap.netKg === null ? null : `${text(snap.netKg)} kg`],
          ['Exit clearance', snap.exitClearance],
          ['Outcome', snap.outcome],
        ];
  const y = rows(doc, M + 70, items);
  if (qrToken !== null) {
    const png = await QRCode.toBuffer(qrToken, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 220,
    });
    doc.image(png, M + WIDTH / 2 - 60, y + 10, { width: 120 });
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(
        `${pass.passNo} · scan at the ${pass.type === 'INWARD' ? 'receiving desk' : 'exit gate'} · valid until ${when(pass.expiresAt.toISOString())}`,
        M,
        y + 136,
        { width: WIDTH, align: 'center' },
      );
  } else {
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(BRAND)
      .text(`PASS ${pass.status}`, M, y + 20, { width: WIDTH, align: 'center' });
  }
  doc.end();
  return done;
}

export function renderSlipPdf(s: {
  entryNo: string;
  shipmentNo: string;
  warehouseName: string;
  vehicleDisplay: string;
  driverName: string;
  driverVerified: boolean;
  gross: { kg: number; at: string; scale: string | null; slipNo: string | null } | null;
  tare: { kg: number; at: string; scale: string | null; slipNo: string | null } | null;
  netKg: number | null;
  varianceKg: number | null;
  result: string | null;
}): Promise<Buffer> {
  const { doc, done } = createDoc(
    `Weighment slip ${s.entryNo}`,
    new Date(s.tare?.at ?? s.gross?.at ?? Date.now()),
  );
  header(doc, 'WEIGHMENT SLIP', s.entryNo, `${s.warehouseName} · ${s.shipmentNo}`);
  const y = rows(doc, M + 70, [
    ['Vehicle number', s.vehicleDisplay],
    ['Driver', `${s.driverName}${s.driverVerified ? ' (verified)' : ''}`],
    ['Gross weight', s.gross === null ? null : `${text(s.gross.kg)} kg`],
    ['Gross time', when(s.gross?.at)],
    [
      'Gross scale / slip',
      s.gross === null ? null : `${text(s.gross.scale)} / ${text(s.gross.slipNo)}`,
    ],
    ['Tare weight', s.tare === null ? null : `${text(s.tare.kg)} kg`],
    ['Tare time', when(s.tare?.at)],
    [
      'Tare scale / slip',
      s.tare === null ? null : `${text(s.tare.scale)} / ${text(s.tare.slipNo)}`,
    ],
  ]);
  doc
    .moveTo(M, y + 4)
    .lineTo(M + WIDTH, y + 4)
    .strokeColor(RULE)
    .stroke();
  rows(doc, y + 12, [
    ['NET CARGO WEIGHT', s.netKg === null ? null : `${text(s.netKg)} kg`],
    ['Variance vs expected', s.varianceKg === null ? null : `${text(s.varianceKg)} kg`],
    ['Result', s.result],
  ]);
  doc.end();
  return done;
}
