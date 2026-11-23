/**
 * Pure stock rules (D-57a): status columns, sellable / damaged deltas, FEFO order, quality
 * status, document numbers, settings defaults. No I/O.
 */

export const STOCK_STATUSES = [
  'RECEIVED',
  'QC_HOLD',
  'AVAILABLE',
  'RESERVED',
  'PICKED',
  'PACKED',
  'DISPATCHED',
  'DELIVERED',
  'QUARANTINED',
  'DAMAGED',
  'EXPIRED',
  'IN_TRANSIT',
  'RETURNED',
  'WRITTEN_OFF',
] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

export const OWNER_TYPES = ['SOR', 'FARMX', 'JIT'] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

export const OWNER_LABEL: Record<OwnerType, string> = {
  SOR: 'Vendor-owned (SOR)',
  FARMX: 'FarmX-owned',
  JIT: 'Vendor-title (JIT)',
};

/** At-rest statuses → position / summary column. Others are moves into or out of the warehouse. */
export const COLUMN = {
  QC_HOLD: 'qcHold',
  AVAILABLE: 'available',
  RESERVED: 'reserved',
  PICKED: 'picked',
  PACKED: 'packed',
  QUARANTINED: 'quarantined',
  DAMAGED: 'damaged',
  EXPIRED: 'expired',
  RETURNED: 'returned',
} as const satisfies Partial<Record<StockStatus, string>>;
export type ColumnStatus = keyof typeof COLUMN;
export type Column = (typeof COLUMN)[ColumnStatus];
export const COLUMNS = Object.values(COLUMN) as Column[];

export const isColumn = (s: StockStatus): s is ColumnStatus => s in COLUMN;

/** Stock inventory may sell or has promised (inventory `onHand`). */
export const SELLABLE: ReadonlySet<StockStatus> = new Set([
  'AVAILABLE',
  'RESERVED',
  'PICKED',
  'PACKED',
]);

/** Moves owned by fulfilment / transfers, never by the generic status-change API. */
export const FLOW_ONLY: ReadonlySet<StockStatus> = new Set([
  'RESERVED',
  'PICKED',
  'PACKED',
  'DISPATCHED',
  'DELIVERED',
  'IN_TRANSIT',
]);

export type Quantities = Record<Column, number>;

export const zeroQty = (): Quantities =>
  Object.fromEntries(COLUMNS.map((c) => [c, 0])) as Quantities;

/** Physical on-hand = every at-rest column (Figma: 887 = 685 + 180 + 10 + 2 + 10). */
export const physical = (q: Quantities): number => COLUMNS.reduce((s, c) => s + q[c], 0);

/** reserved + picked + packed (what screens call "Reserved"). */
export const reservedTotal = (q: Quantities): number => q.reserved + q.picked + q.packed;

/** Blocked (donut): damaged + quarantined + expired. */
export const blockedTotal = (q: Quantities): number => q.damaged + q.quarantined + q.expired;

/** What inventory must apply for one move of `qty` units. */
export const inventoryDeltas = (
  from: StockStatus,
  to: StockStatus,
  qty: number,
): { sellable: number; damaged: number } => ({
  sellable: (SELLABLE.has(to) ? qty : 0) - (SELLABLE.has(from) ? qty : 0),
  damaged: (to === 'DAMAGED' ? qty : 0) - (from === 'DAMAGED' ? qty : 0),
});

/** Batch quality label (W4.04 "Quality status"). */
export const qualityStatus = (
  q: Quantities,
): 'RELEASED' | 'PARTIALLY_HOLD' | 'ON_HOLD' | 'EMPTY' => {
  const held = q.qcHold + q.quarantined;
  const total = physical(q);
  if (total === 0) return 'EMPTY';
  if (held === 0) return 'RELEASED';
  return held === total ? 'ON_HOLD' : 'PARTIALLY_HOLD';
};

/** FEFO: earliest expiry first, unknown expiry last, then oldest receipt, then id. */
export const fefoCompare = (
  a: { expiryDate: Date | null; receivedAt: Date; id: string },
  b: { expiryDate: Date | null; receivedAt: Date; id: string },
): number => {
  if (a.expiryDate === null && b.expiryDate !== null) return 1;
  if (a.expiryDate !== null && b.expiryDate === null) return -1;
  if (a.expiryDate !== null && b.expiryDate !== null) {
    const d = a.expiryDate.getTime() - b.expiryDate.getTime();
    if (d !== 0) return d;
  }
  const r = a.receivedAt.getTime() - b.receivedAt.getTime();
  return r !== 0 ? r : a.id.localeCompare(b.id);
};

/** YYMM of a date (document number period), IST. */
export const periodOf = (d: Date): number => {
  const ist = new Date(d.getTime() + 330 * 60_000);
  return (ist.getUTCFullYear() % 100) * 100 + (ist.getUTCMonth() + 1);
};

/** CN-2611-0001, ADJ-2611-0007, RST-2611-0003, TR-2611-0041. */
export const docNo = (kind: 'CN' | 'ADJ' | 'RST' | 'TR', period: number, n: number): string =>
  `${kind}-${String(period).padStart(4, '0')}-${String(n).padStart(4, '0')}`;

/** Unit QR code: FX-<SKU>-<batch>-<seq>. Only [A-Z0-9-] kept. */
export const qrCode = (sku: string, batchNo: string, seq: number): string => {
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '');
  return `FX-${clean(sku)}-${clean(batchNo)}-${String(seq).padStart(4, '0')}`.slice(0, 64);
};

export type WritesMode = 'INVENTORY' | 'FROZEN' | 'WMS';

export interface StockSettingValues {
  'stock.writesMode': WritesMode;
  /** Receipts land in QC hold (true) or straight in available (false). */
  'stock.qcOnReceipt': boolean;
  'stock.nearExpiryDays': number;
  /** Adjustments above this many units wait for a second person. */
  'stock.adjustApprovalUnits': number;
  /** W4.05 "Stock release: Controlled via OMS approval". */
  'stock.releasePolicy': 'CONTROLLED' | 'AUTO';
  /** Categories whose units always get a unit QR. */
  'stock.serializedCategoryIds': string[];
  /** Cutover freeze limit and rollback window (§2a.1). */
  'stock.freezeMaxMinutes': number;
  'stock.rollbackWindowHours': number;
  /** Cutover state (set by the cutover service). */
  'stock.cutover': CutoverState | null;
}

/** Settings with code defaults (rows in `warehouse_settings` override them). */
export const STOCK_SETTINGS: StockSettingValues = {
  'stock.writesMode': 'INVENTORY',
  'stock.qcOnReceipt': true,
  'stock.nearExpiryDays': 90,
  'stock.adjustApprovalUnits': 50,
  'stock.releasePolicy': 'CONTROLLED',
  'stock.serializedCategoryIds': [],
  'stock.freezeMaxMinutes': 120,
  'stock.rollbackWindowHours': 72,
  'stock.cutover': null,
};
export type StockSettingKey = keyof StockSettingValues;

export interface CutoverState {
  phase: 'FROZEN' | 'ACTIVE' | 'ROLLED_BACK';
  frozenAt?: string;
  freezeDeadline?: string;
  activatedAt?: string;
  rolledBackAt?: string;
  reason?: string;
  report?: Record<string, unknown>;
}

/** Units → kg for one SKU (null when the weight is unknown). */
export const kgOf = (units: number, weightGrams: number | null): number | null =>
  weightGrams === null || weightGrams <= 0 ? null : Math.round(units * weightGrams) / 1000;
