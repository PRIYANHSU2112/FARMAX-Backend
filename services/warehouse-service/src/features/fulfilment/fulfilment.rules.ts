/** Pure fulfilment rules (D-57b): shipment state machine, SLA, distances, KPI maths. No I/O. */

export const SHIPMENT_STATUSES = [
  'PENDING_RELEASE',
  'RELEASED',
  'ALLOCATED',
  'ASSIGNED',
  'PICKING',
  'PACKING',
  'QC',
  'READY_TO_DISPATCH',
  'DISPATCHED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FULFILLED',
  'DELIVERY_FAILED',
  'RETURNED_TO_WAREHOUSE',
  'CANCELLED',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** Still in the warehouse and not closed. */
export const IN_WAREHOUSE: readonly ShipmentStatus[] = [
  'PENDING_RELEASE',
  'RELEASED',
  'ALLOCATED',
  'ASSIGNED',
  'PICKING',
  'PACKING',
  'QC',
  'READY_TO_DISPATCH',
];
/** Released and still to be dispatched ("active" on W3.02 / W3.01). */
export const ACTIVE: readonly ShipmentStatus[] = IN_WAREHOUSE.filter(
  (s) => s !== 'PENDING_RELEASE',
);
/** Edit / warehouse cancel allowed (before picking). */
export const PRE_PICK: readonly ShipmentStatus[] = [
  'PENDING_RELEASE',
  'RELEASED',
  'ALLOCATED',
  'ASSIGNED',
];
export const ON_FLOOR: readonly ShipmentStatus[] = [
  'PICKING',
  'PACKING',
  'QC',
  'READY_TO_DISPATCH',
];
export const OUT_OF_WAREHOUSE: readonly ShipmentStatus[] = [
  'DISPATCHED',
  'OUT_FOR_DELIVERY',
  'DELIVERY_FAILED',
];
export const DONE: readonly ShipmentStatus[] = ['DELIVERED', 'FULFILLED'];
export const CLOSED: readonly ShipmentStatus[] = [
  'FULFILLED',
  'RETURNED_TO_WAREHOUSE',
  'CANCELLED',
];

/** Allowed moves of the shipment state machine (hold is a flag that blocks forward moves). */
export const NEXT: Record<ShipmentStatus, readonly ShipmentStatus[]> = {
  PENDING_RELEASE: ['RELEASED', 'CANCELLED'],
  RELEASED: ['ALLOCATED', 'CANCELLED'],
  ALLOCATED: ['ASSIGNED', 'PICKING', 'RELEASED', 'CANCELLED'],
  ASSIGNED: ['PICKING', 'ALLOCATED', 'RELEASED', 'CANCELLED'],
  PICKING: ['PACKING', 'CANCELLED'],
  PACKING: ['QC', 'CANCELLED'],
  QC: ['READY_TO_DISPATCH', 'PACKING', 'CANCELLED'],
  READY_TO_DISPATCH: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: ['OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'DELIVERY_FAILED'],
  DELIVERY_FAILED: ['OUT_FOR_DELIVERY', 'RETURNED_TO_WAREHOUSE'],
  DELIVERED: ['FULFILLED'],
  FULFILLED: [],
  RETURNED_TO_WAREHOUSE: [],
  CANCELLED: [],
};

/** Moves that need no hold check (backwards, cancel, delivery side). */
const HOLD_FREE: readonly ShipmentStatus[] = [
  'CANCELLED',
  'RELEASED',
  'ALLOCATED',
  'DELIVERED',
  'DELIVERY_FAILED',
  'OUT_FOR_DELIVERY',
  'RETURNED_TO_WAREHOUSE',
  'FULFILLED',
];
export const blockedByHold = (from: ShipmentStatus, to: ShipmentStatus): boolean =>
  !HOLD_FREE.includes(to) || (to === 'ALLOCATED' && from === 'RELEASED');

/** Timestamp column stamped when a shipment enters a status. */
export const STAMP: Partial<Record<ShipmentStatus, string>> = {
  RELEASED: 'releasedAt',
  ALLOCATED: 'allocatedAt',
  ASSIGNED: 'assignedAt',
  PICKING: 'pickStartedAt',
  PACKING: 'pickedAt',
  QC: 'packedAt',
  READY_TO_DISPATCH: 'stagedAt',
  DISPATCHED: 'dispatchedAt',
  OUT_FOR_DELIVERY: 'outForDeliveryAt',
  DELIVERED: 'deliveredAt',
  FULFILLED: 'fulfilledAt',
  CANCELLED: 'cancelledAt',
};

export const RANK = new Map<ShipmentStatus, number>(SHIPMENT_STATUSES.map((s, i) => [s, i]));

/** Dashboard 8-status strip (W3.01, §3.3). */
export const STRIP: { key: string; label: string; statuses: readonly ShipmentStatus[] }[] = [
  { key: 'NEW', label: 'New', statuses: ['RELEASED'] },
  { key: 'ALLOCATED', label: 'Allocated', statuses: ['ALLOCATED', 'ASSIGNED'] },
  { key: 'PICKING', label: 'Picking', statuses: ['PICKING'] },
  { key: 'PACKING', label: 'Packing', statuses: ['PACKING', 'QC'] },
  { key: 'READY', label: 'Ready to dispatch', statuses: ['READY_TO_DISPATCH'] },
  { key: 'DISPATCHED', label: 'Dispatched', statuses: ['DISPATCHED', 'OUT_FOR_DELIVERY'] },
  { key: 'DELIVERED', label: 'Delivered', statuses: ['DELIVERED'] },
  { key: 'FULFILLED', label: 'Fulfilled', statuses: ['FULFILLED'] },
];

/** W3.07 processing stage tabs. */
export const STAGES: Record<string, readonly ShipmentStatus[]> = {
  all: ['ALLOCATED', 'ASSIGNED', 'PICKING', 'PACKING', 'QC', 'READY_TO_DISPATCH'],
  allocated: ['ALLOCATED', 'ASSIGNED'],
  picking: ['PICKING'],
  packing: ['PACKING'],
  qc: ['QC'],
  ready: ['READY_TO_DISPATCH'],
};

// ── Time (India: IST, UTC+05:30) ──

const IST_MS = 330 * 60_000;
/** Calendar day in IST, "YYYY-MM-DD". */
export const istDay = (d: Date): string =>
  new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);
/** UTC instant of an IST wall time on an IST day. */
export const istAt = (day: string, hhmm: string): Date =>
  new Date(new Date(`${day}T${hhmm}:00.000Z`).getTime() - IST_MS);
/** ISO weekday (1 = Monday … 7 = Sunday) of an IST day. */
export const isoDayOf = (day: string): number => {
  const d = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return d === 0 ? 7 : d;
};
export const addDays = (day: string, n: number): string =>
  new Date(new Date(`${day}T00:00:00.000Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
/** Start of an IST day as a UTC instant. */
export const istStart = (day: string): Date => istAt(day, '00:00');

export interface SlaCalendar {
  hours: readonly {
    isoDay: number;
    isOpen: boolean;
    opensAt: string | null;
    closesAt: string | null;
  }[];
  /** SAME_DAY_STANDARD cut-off "HH:mm" (null = none). */
  cutoff: string | null;
  /** Closed days "YYYY-MM-DD". */
  closed: ReadonlySet<string>;
}

/**
 * SLA due (§3.3): PRIORITY = release + priorityHours. STANDARD = released before today's cut-off on
 * an open day → today's closing time; else the next open day's closing time. Without a calendar
 * (no hours set) → release + 24 h.
 */
export const slaDueAt = (
  releasedAt: Date,
  priority: 'STANDARD' | 'PRIORITY',
  cal: SlaCalendar | null,
  priorityHours: number,
): Date => {
  if (priority === 'PRIORITY') return new Date(releasedAt.getTime() + priorityHours * 3_600_000);
  if (cal === null || cal.hours.every((h) => !h.isOpen))
    return new Date(releasedAt.getTime() + 24 * 3_600_000);
  const today = istDay(releasedAt);
  const open = (day: string) => {
    if (cal.closed.has(day)) return null;
    const h = cal.hours.find((x) => x.isoDay === isoDayOf(day));
    return h?.isOpen === true && h.closesAt !== null ? h : null;
  };
  const t = open(today);
  if (t?.closesAt != null) {
    const cutoff = istAt(today, cal.cutoff ?? t.closesAt);
    const close = istAt(today, t.closesAt);
    if (releasedAt < cutoff && releasedAt < close) return close;
  }
  for (let i = 1; i <= 14; i += 1) {
    const day = addDays(today, i);
    const h = open(day);
    if (h?.closesAt != null) return istAt(day, h.closesAt);
  }
  return new Date(releasedAt.getTime() + 24 * 3_600_000);
};

// ── Geography ──

/** Great-circle distance in km (null when a point is unknown). */
export const distanceKm = (
  a: { lat: number | null; lng: number | null },
  b: { lat: number | null; lng: number | null },
): number | null => {
  if (a.lat === null || a.lng === null || b.lat === null || b.lng === null) return null;
  const r = (x: number) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLng = r(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(6371 * 2 * Math.asin(Math.sqrt(h)) * 10) / 10;
};

/**
 * Estimated delivery (W3.04): dispatch lead (hours to the next dispatch) + transit at
 * `avgKmph`, ± 25 %. Label: same day when it lands before 20:00 IST today, else next day / n days.
 */
export const deliveryEstimate = (
  now: Date,
  leadHours: number,
  km: number | null,
  avgKmph: number,
): { label: string; minHours: number; maxHours: number } | null => {
  if (km === null) return null;
  const hours = leadHours + km / Math.max(avgKmph, 1);
  const minHours = Math.max(1, Math.floor(hours * 0.75));
  const maxHours = Math.ceil(hours * 1.25);
  const arrive = new Date(now.getTime() + maxHours * 3_600_000);
  const days = Math.round(
    (istStart(istDay(arrive)).getTime() - istStart(istDay(now)).getTime()) / 86_400_000,
  );
  const label = days <= 0 ? 'Same day' : days === 1 ? 'Next day' : `${String(days)} days`;
  return { label: `${label} (${String(minHours)}–${String(maxHours)} hrs)`, minHours, maxHours };
};

// ── Shelf life ──

export const daysLeft = (expiry: Date | null, today: Date): number | null =>
  expiry === null ? null : Math.floor((expiry.getTime() - today.getTime()) / 86_400_000);

/** Most specific active shelf-life rule (state + category + farm > two > one > none). */
export const pickShelfLifeRule = <
  R extends {
    stateCode: string | null;
    rootCategoryId: string | null;
    farmCategory: string | null;
    isActive: boolean;
  },
>(
  rules: readonly R[],
  ctx: { stateCode: string | null; rootCategoryId: string | null; farmCategory: string | null },
): R | null => {
  let best: R | null = null;
  let bestScore = -1;
  for (const r of rules) {
    if (!r.isActive) continue;
    if (r.stateCode !== null && r.stateCode !== ctx.stateCode) continue;
    if (r.rootCategoryId !== null && r.rootCategoryId !== ctx.rootCategoryId) continue;
    if (r.farmCategory !== null && r.farmCategory !== ctx.farmCategory) continue;
    const score =
      (r.stateCode === null ? 0 : 1) +
      (r.rootCategoryId === null ? 0 : 1) +
      (r.farmCategory === null ? 0 : 1);
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
};

// ── Settings (defaults; admin overrides in `warehouse_settings`) ──

export interface ChecklistItem {
  key: string;
  label: string;
}

export interface FulfilmentSettingValues {
  'fulfilment.priorityDispatchHours': number;
  'fulfilment.onTimeWindowHours': number;
  'fulfilment.graceHours': number;
  'fulfilment.pickTargetMin': number;
  'fulfilment.bulkMinKg': number;
  'fulfilment.keepAllocationHours': number;
  'fulfilment.holdReserveCapPct': number;
  'fulfilment.avgTransitKmph': number;
  'fulfilment.minShelfLifeDays': number;
  'fulfilment.refreshAfterSec': number;
  'fulfilment.readinessBands': { optimal: number; watch: number };
  'fulfilment.exceptionSlaHours': Record<'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL', number>;
  'fulfilment.checklistTemplate': ChecklistItem[];
  'fulfilment.qcChecklist': ChecklistItem[];
  'fulfilment.sop': { title: string | null; steps: string[]; documentUrl: string | null };
  'fulfilment.complianceSlaHours': number;
  'fulfilment.complianceAutoRejectHours': number;
  'fulfilment.complianceGateLabel': string | null;
  'fulfilment.complianceGuidelinesUrl': string | null;
  'fulfilment.weighTolerancePct': number;
  'fulfilment.pingMinIntervalSec': number;
  'fulfilment.settleOverdueDays': number;
  'fulfilment.otpTtlHours': number;
  'fulfilment.otpMaxAttempts': number;
  'fulfilment.otpResendCooldownSec': number;
  'fulfilment.otpMaxResends': number;
  'fulfilment.allocationFallback': {
    strategy: 'NEXT_NEAREST' | 'ALTERNATE_REGIONAL_HUB' | 'NODE_LIST' | 'CENTRAL' | 'HOLD_ORDER';
    nodeIds: string[];
    centralWarehouseId: string | null;
    allowPartial: boolean;
    maxDistanceKm: number | null;
  };
}
export type FulfilmentSettingKey = keyof FulfilmentSettingValues;

export const FULFILMENT_SETTINGS: FulfilmentSettingValues = {
  'fulfilment.priorityDispatchHours': 6,
  'fulfilment.onTimeWindowHours': 4,
  'fulfilment.graceHours': 2,
  'fulfilment.pickTargetMin': 30,
  'fulfilment.bulkMinKg': 1000,
  'fulfilment.keepAllocationHours': 4,
  'fulfilment.holdReserveCapPct': 20,
  'fulfilment.avgTransitKmph': 40,
  'fulfilment.minShelfLifeDays': 0,
  'fulfilment.refreshAfterSec': 60,
  'fulfilment.readinessBands': { optimal: 90, watch: 75 },
  'fulfilment.exceptionSlaHours': { LOW: 24, MEDIUM: 12, HIGH: 4, CRITICAL: 2 },
  'fulfilment.checklistTemplate': [
    { key: 'verify_items', label: 'Verify SKUs and quantities against the pick list' },
    { key: 'scan_batches', label: 'Pick the allocated FEFO batches from the listed bins' },
    { key: 'check_expiry', label: 'Check expiry dates and packaging condition' },
    { key: 'cold_chain', label: 'Keep cold-chain items at 2–8 °C (when required)' },
    { key: 'label_seal', label: 'Pack, label and seal every package' },
  ],
  'fulfilment.qcChecklist': [
    { key: 'qty_match', label: 'Quantities match the order' },
    { key: 'batch_match', label: 'Batches match the allocation' },
    { key: 'packaging', label: 'Packaging intact and sealed' },
    { key: 'labels', label: 'Labels and documents attached' },
  ],
  'fulfilment.sop': { title: null, steps: [], documentUrl: null },
  'fulfilment.complianceSlaHours': 24,
  'fulfilment.complianceAutoRejectHours': 72,
  'fulfilment.complianceGateLabel': null,
  'fulfilment.complianceGuidelinesUrl': null,
  'fulfilment.weighTolerancePct': 2,
  'fulfilment.pingMinIntervalSec': 30,
  'fulfilment.settleOverdueDays': 7,
  'fulfilment.otpTtlHours': 12,
  'fulfilment.otpMaxAttempts': 5,
  'fulfilment.otpResendCooldownSec': 60,
  'fulfilment.otpMaxResends': 5,
  'fulfilment.allocationFallback': {
    strategy: 'NEXT_NEAREST',
    nodeIds: [],
    centralWarehouseId: null,
    allowPartial: true,
    maxDistanceKm: null,
  },
};

/** Exception SLA from its severity. */
export const exceptionDue = (
  at: Date,
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
  hours: FulfilmentSettingValues['fulfilment.exceptionSlaHours'],
): Date => new Date(at.getTime() + hours[severity] * 3_600_000);

/** Percent with one decimal (null when the base is 0). */
export const pct = (n: number, d: number): number | null =>
  d === 0 ? null : Math.round((n / d) * 1000) / 10;
