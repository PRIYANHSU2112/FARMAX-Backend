/**
 * Gate & weighbridge rules (D-62 §1a). Pure functions only: the entry state machine, pause /
 * resume, the step bar, weight math (reconciliation + exit check), re-delivery document rules,
 * plate / mobile / document masks, the audit sanitizer and the ETag minute bucket.
 */

export type EntryStatus =
  | 'ARRIVED'
  | 'WEIGHED_IN'
  | 'APPROVED'
  | 'UNLOADING'
  | 'UNLOADED'
  | 'WEIGHED_OUT'
  | 'PASS_OUT'
  | 'BLOCKED'
  | 'HELD'
  | 'REJECTED'
  | 'EXITED'
  | 'CANCELLED';

export type ShipmentStage =
  'EXPECTED' | Exclude<EntryStatus, 'EXITED' | 'CANCELLED'> | 'COMPLETED' | 'CANCELLED';

export type Outcome = 'COMPLETED' | 'REJECTED';
export type ShipmentAction = 'REEXPECT' | 'CANCEL';
export type Purpose = 'INBOUND_CONSIGNMENT' | 'STOCK_TRANSFER' | 'CUSTOMER_RETURN' | 'OTHER';
export type DocType =
  | 'PURCHASE_ORDER'
  | 'DELIVERY_CHALLAN'
  | 'INVOICE'
  | 'EWAY_BILL'
  | 'RC_BOOK'
  | 'PERMIT'
  | 'INSURANCE'
  | 'DRIVER_LICENCE'
  | 'OTHER';
export type DocStatus = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXEMPTED';
export type ReconResult = 'WITHIN' | 'BREACH' | 'NO_DECLARED_WEIGHT';
export type HoldResolution = 'ACCEPT_VARIANCE' | 'REWEIGH' | 'ACCEPT_WITH_DEBIT_NOTE';

export const TERMINAL: readonly EntryStatus[] = ['EXITED', 'CANCELLED'];
/** Truck still inside the gate (partial unique key scope). */
export const isActive = (s: EntryStatus): boolean => !TERMINAL.includes(s);

// ── state machine (§1a) ──

export type Action =
  | 'GROSS'
  | 'APPROVE'
  | 'BLOCK'
  | 'UNBLOCK'
  | 'TURN_AWAY'
  | 'HANDOVER'
  | 'UNLOAD'
  | 'TARE_WITHIN'
  | 'TARE_HOLD'
  | 'HOLD'
  | 'RESOLVE_ACCEPT'
  | 'OUTWARD_PASS'
  | 'EXIT'
  | 'CANCEL';

/** Statuses an action may start from. */
export const FROM: Record<Action, readonly EntryStatus[]> = {
  GROSS: ['ARRIVED'],
  APPROVE: ['ARRIVED', 'WEIGHED_IN'],
  BLOCK: ['ARRIVED', 'WEIGHED_IN', 'APPROVED'],
  UNBLOCK: ['BLOCKED'],
  TURN_AWAY: ['ARRIVED', 'WEIGHED_IN', 'BLOCKED', 'APPROVED'],
  HANDOVER: ['APPROVED'],
  UNLOAD: ['UNLOADING'],
  TARE_WITHIN: ['UNLOADED'],
  TARE_HOLD: ['UNLOADED'],
  HOLD: ['UNLOADED', 'WEIGHED_OUT'],
  RESOLVE_ACCEPT: ['HELD'],
  OUTWARD_PASS: ['WEIGHED_OUT', 'REJECTED'],
  EXIT: ['PASS_OUT'],
  CANCEL: ['ARRIVED'],
};

const TO: Partial<Record<Action, EntryStatus>> = {
  GROSS: 'WEIGHED_IN',
  APPROVE: 'APPROVED',
  BLOCK: 'BLOCKED',
  TURN_AWAY: 'REJECTED',
  HANDOVER: 'UNLOADING',
  UNLOAD: 'UNLOADED',
  TARE_WITHIN: 'WEIGHED_OUT',
  TARE_HOLD: 'HELD',
  HOLD: 'HELD',
  // HELD accept → WEIGHED_OUT (never back to pausedFromStatus).
  RESOLVE_ACCEPT: 'WEIGHED_OUT',
  OUTWARD_PASS: 'PASS_OUT',
  EXIT: 'EXITED',
  CANCEL: 'CANCELLED',
};

export interface EntryState {
  status: EntryStatus;
  pausedFromStatus: EntryStatus | null;
}

export type Transition =
  | { ok: true; to: EntryStatus; pausedFromStatus: EntryStatus | null }
  | { ok: false; reason: 'STALE_STATE' };

/**
 * The next status of an action, or STALE_STATE. BLOCK / HOLD remember where they paused;
 * UNBLOCK resumes there; every other move clears the pause.
 */
export const transition = (action: Action, e: EntryState): Transition => {
  if (!FROM[action].includes(e.status)) return { ok: false, reason: 'STALE_STATE' };
  if (action === 'UNBLOCK') {
    const back = e.pausedFromStatus;
    if (back === null) return { ok: false, reason: 'STALE_STATE' };
    return { ok: true, to: back, pausedFromStatus: null };
  }
  const to = TO[action];
  if (to === undefined) return { ok: false, reason: 'STALE_STATE' };
  const pauses = to === 'BLOCKED' || to === 'HELD';
  return { ok: true, to, pausedFromStatus: pauses ? e.status : null };
};

/** Shipment stage mirrored from its active entry (COMPLETED / EXPECTED / CANCELLED after exit). */
export const stageOf = (
  status: EntryStatus,
  outcome: Outcome | null,
  action: ShipmentAction | null,
): ShipmentStage => {
  if (status === 'CANCELLED') return 'EXPECTED';
  if (status !== 'EXITED') return status;
  if (outcome === 'REJECTED') return action === 'CANCEL' ? 'CANCELLED' : 'EXPECTED';
  return 'COMPLETED';
};

// ── dashboard tabs ──

export type Tab = 'all' | 'expected' | 'arrived' | 'inProgress' | 'blocked' | 'completed';
export const TAB_STAGES: Record<Exclude<Tab, 'all'>, readonly ShipmentStage[]> = {
  expected: ['EXPECTED'],
  arrived: ['ARRIVED'],
  inProgress: ['WEIGHED_IN', 'APPROVED', 'UNLOADING', 'UNLOADED', 'WEIGHED_OUT', 'PASS_OUT'],
  blocked: ['BLOCKED', 'HELD', 'REJECTED'],
  completed: ['COMPLETED'],
};
export const tabOf = (stage: ShipmentStage): Exclude<Tab, 'all'> | null => {
  for (const [tab, stages] of Object.entries(TAB_STAGES))
    if (stages.includes(stage)) return tab as Exclude<Tab, 'all'>;
  return null;
};

export const STAGE_LABEL: Record<ShipmentStage, string> = {
  EXPECTED: 'Expected',
  ARRIVED: 'Arrived',
  WEIGHED_IN: 'In progress',
  APPROVED: 'In progress',
  UNLOADING: 'In progress',
  UNLOADED: 'In progress',
  WEIGHED_OUT: 'In progress',
  PASS_OUT: 'In progress',
  BLOCKED: 'Blocked',
  HELD: 'Held',
  REJECTED: 'Rejected',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

// ── step bar "01 Shipment … 08 Outward pass" ──

export const STEPS = [
  { no: 1, key: 'SHIPMENT', label: 'Shipment' },
  { no: 2, key: 'ARRIVAL', label: 'Arrival' },
  { no: 3, key: 'GROSS_WEIGHT', label: 'Gross weight' },
  { no: 4, key: 'DOCUMENTS', label: 'Documents' },
  { no: 5, key: 'GATE_PASS', label: 'Gate pass' },
  { no: 6, key: 'RECEIVING', label: 'Receiving' },
  { no: 7, key: 'EXIT_TARE', label: 'Exit tare' },
  { no: 8, key: 'OUTWARD_PASS', label: 'Outward pass' },
] as const;

/** Index (0-based) of the step being worked on in a status. */
const CURRENT_STEP: Record<EntryStatus, number> = {
  ARRIVED: 2,
  WEIGHED_IN: 3,
  APPROVED: 4,
  UNLOADING: 5,
  UNLOADED: 6,
  WEIGHED_OUT: 7,
  PASS_OUT: 7,
  REJECTED: 7,
  EXITED: 8,
  CANCELLED: 1,
  BLOCKED: 3,
  HELD: 6,
};

export type StepState = 'DONE' | 'CURRENT' | 'PENDING' | 'SKIPPED';

export interface Pause {
  kind: 'BLOCKED' | 'HELD';
  reason: string | null;
  since: string | null;
}

/**
 * Step bar of an entry (or of a shipment without one: step 1 done, step 2 current). While
 * BLOCKED / HELD the bar stays on the paused step and `pause` says why. A REJECTED truck skips
 * receiving and tare.
 */
export const stepsOf = (
  e: (EntryState & { outcome: Outcome | null }) | null,
  pause: Pause | null = null,
) => {
  const effective: EntryStatus | null =
    e === null
      ? null
      : (e.status === 'BLOCKED' || e.status === 'HELD') && e.pausedFromStatus !== null
        ? e.pausedFromStatus
        : e.status;
  const current = effective === null ? 1 : CURRENT_STEP[effective];
  const rejected = e?.status === 'REJECTED' || e?.outcome === 'REJECTED';
  return {
    current: Math.min(current, STEPS.length - 1) + 1,
    pause,
    steps: STEPS.map((s, i) => {
      let state: StepState =
        i < current ? 'DONE' : i === current && current < STEPS.length ? 'CURRENT' : 'PENDING';
      if (rejected && (s.key === 'RECEIVING' || s.key === 'EXIT_TARE' || s.key === 'GATE_PASS'))
        state = 'SKIPPED';
      if (e?.status === 'EXITED') state = state === 'SKIPPED' ? 'SKIPPED' : 'DONE';
      return { ...s, state };
    }),
  };
};

// ── weight math ──

export interface Tolerance {
  pct: number;
  minKg: number;
}
export interface Allowance {
  pct: number;
  perPalletKg: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Expected load on the scale: invoice gross when the vendor declared it, else declared net +
 * packaging allowance (pct of net + pallets). Null when nothing can be computed (missing product
 * weights and no invoice gross) → the entry goes to HELD NO_DECLARED_WEIGHT.
 */
export const expectedLoad = (i: {
  invoiceGrossKg: number | null;
  declaredNetKg: number | null;
  palletCount: number | null;
  allowance: Allowance;
}): {
  basis: 'INVOICE_GROSS' | 'NET_PLUS_PACKAGING';
  declaredNetKg: number | null;
  packagingAllowanceKg: number;
  expectedLoadKg: number;
} | null => {
  if (i.invoiceGrossKg !== null && i.invoiceGrossKg > 0)
    return {
      basis: 'INVOICE_GROSS',
      declaredNetKg: i.declaredNetKg,
      packagingAllowanceKg: 0,
      expectedLoadKg: round2(i.invoiceGrossKg),
    };
  if (i.declaredNetKg === null || i.declaredNetKg <= 0) return null;
  const packaging = round2(
    (i.declaredNetKg * i.allowance.pct) / 100 + (i.palletCount ?? 0) * i.allowance.perPalletKg,
  );
  return {
    basis: 'NET_PLUS_PACKAGING',
    declaredNetKg: round2(i.declaredNetKg),
    packagingAllowanceKg: packaging,
    expectedLoadKg: round2(i.declaredNetKg + packaging),
  };
};

export const toleranceKg = (baseKg: number, t: Tolerance): number =>
  round2(Math.max((baseKg * t.pct) / 100, t.minKg));

export interface Reconciliation {
  basis: 'INVOICE_GROSS' | 'NET_PLUS_PACKAGING' | null;
  grossKg: number;
  tareKg: number;
  measuredNetKg: number;
  declaredNetKg: number | null;
  packagingAllowanceKg: number | null;
  expectedLoadKg: number | null;
  varianceKg: number | null;
  toleranceKg: number | null;
  result: ReconResult;
}

/** Measured net (gross − tare) against the expected load, within max(pct × expected, minKg). */
export const reconcile = (i: {
  grossKg: number;
  tareKg: number;
  expected: ReturnType<typeof expectedLoad>;
  tolerance: Tolerance;
}): Reconciliation => {
  const net = round2(i.grossKg - i.tareKg);
  if (i.expected === null)
    return {
      basis: null,
      grossKg: i.grossKg,
      tareKg: i.tareKg,
      measuredNetKg: net,
      declaredNetKg: null,
      packagingAllowanceKg: null,
      expectedLoadKg: null,
      varianceKg: null,
      toleranceKg: null,
      result: 'NO_DECLARED_WEIGHT',
    };
  const variance = round2(net - i.expected.expectedLoadKg);
  const tol = toleranceKg(i.expected.expectedLoadKg, i.tolerance);
  return {
    basis: i.expected.basis,
    grossKg: i.grossKg,
    tareKg: i.tareKg,
    measuredNetKg: net,
    declaredNetKg: i.expected.declaredNetKg,
    packagingAllowanceKg: i.expected.packagingAllowanceKg,
    expectedLoadKg: i.expected.expectedLoadKg,
    varianceKg: variance,
    toleranceKg: tol,
    result: Math.abs(variance) <= tol ? 'WITHIN' : 'BREACH',
  };
};

/** Turned-away truck: the exit weight must be ≈ gross (nothing was offloaded). */
export const exitCheck = (grossKg: number, exitKg: number, t: Tolerance) => {
  const allowed = toleranceKg(grossKg, t);
  const diff = round2(exitKg - grossKg);
  return {
    differenceKg: diff,
    allowedKg: allowed,
    result: Math.abs(diff) <= allowed ? ('WITHIN' as const) : ('MISMATCH' as const),
  };
};

// ── documents ──

/** Vehicle / driver bound: reset on a re-delivery (a different truck may come). */
export const VEHICLE_BOUND: readonly DocType[] = [
  'RC_BOOK',
  'PERMIT',
  'INSURANCE',
  'DRIVER_LICENCE',
  'EWAY_BILL',
];
/** PII-bearing scans purged by the retention job. */
export const PII_DOCS: readonly DocType[] = ['DRIVER_LICENCE', 'RC_BOOK'];

export const DOC_LABEL: Record<DocType, string> = {
  PURCHASE_ORDER: 'Purchase order',
  DELIVERY_CHALLAN: 'Delivery challan',
  INVOICE: 'Invoice',
  EWAY_BILL: 'E-way bill',
  RC_BOOK: 'RC book',
  PERMIT: 'Permit',
  INSURANCE: 'Insurance',
  DRIVER_LICENCE: 'Driver licence',
  OTHER: 'Other document',
};

/** A YYYY-MM-DD date column that is before today (IST date string). */
export const isExpired = (validUntil: string | null, today: string): boolean =>
  validUntil !== null && validUntil < today;

/**
 * What happens to a document when a turned-away shipment is expected again (§1a):
 * vehicle-bound → PENDING; expired → PENDING + EXPIRED; REJECTED stays; others carry forward.
 */
export const redeliveryDoc = (
  d: { docType: DocType; status: DocStatus; validUntil: string | null },
  today: string,
): { status: DocStatus; expired: boolean; carriedForward: boolean } => {
  if (d.status === 'REJECTED') return { status: 'REJECTED', expired: false, carriedForward: false };
  if (isExpired(d.validUntil, today))
    return { status: 'PENDING', expired: true, carriedForward: false };
  if (VEHICLE_BOUND.includes(d.docType))
    return { status: 'PENDING', expired: false, carriedForward: false };
  return { status: d.status, expired: false, carriedForward: d.status !== 'PENDING' };
};

export interface ChecklistDoc {
  docType: DocType;
  status: DocStatus;
  required: boolean;
  validUntil: string | null;
}

/** W5.06 KPI cards + the clearance hint. */
export const checklist = (
  required: readonly DocType[],
  docs: readonly ChecklistDoc[],
  today: string,
) => {
  const best = (t: DocType) => {
    const of = docs.filter((d) => d.docType === t);
    return (
      of.find((d) => d.status === 'VERIFIED' || d.status === 'EXEMPTED') ??
      of.find((d) => d.status === 'PENDING') ??
      of[0]
    );
  };
  const rows = required.map((t) => ({ docType: t, doc: best(t) }));
  const done = rows.filter(
    (r) =>
      r.doc !== undefined &&
      (r.doc.status === 'EXEMPTED' ||
        (r.doc.status === 'VERIFIED' && !isExpired(r.doc.validUntil, today))),
  );
  const blocked = rows.filter((r) => r.doc?.status === 'REJECTED');
  const pending = rows.filter((r) => !done.includes(r) && !blocked.includes(r));
  const ewayExpired = docs.some(
    (d) => d.docType === 'EWAY_BILL' && d.status === 'VERIFIED' && isExpired(d.validUntil, today),
  );
  const label = (rs: typeof rows) => rs.map((r) => DOC_LABEL[r.docType]).join(', ');
  return {
    required: rows.length,
    verified: done.length,
    pending: pending.length,
    blocked: blocked.length,
    requiredLabel: label(rows) || 'No documents required',
    verifiedLabel: label(done) || '—',
    pendingLabel: label(pending) || 'Nothing pending',
    blockedLabel: blocked.length === 0 ? 'No entry blocks' : label(blocked),
    complete: pending.length === 0 && blocked.length === 0 && !ewayExpired,
    ewayExpired,
    missing: [...pending, ...blocked].map((r) => r.docType),
    hint:
      blocked.length > 0
        ? {
            tone: 'danger' as const,
            title: `${String(blocked.length)} document${blocked.length === 1 ? '' : 's'} rejected`,
            text: `Request corrected ${label(blocked)} from the vendor or block the entry.`,
          }
        : ewayExpired
          ? {
              tone: 'warning' as const,
              title: 'E-way bill has expired',
              text: 'Verify a valid e-way bill or record the applicable exemption.',
            }
          : pending.length > 0
            ? {
                tone: 'warning' as const,
                title:
                  pending.length === 1
                    ? 'One document requires confirmation'
                    : `${String(pending.length)} documents require confirmation`,
                text:
                  pending.length === 1 && pending[0]?.docType === 'EWAY_BILL'
                    ? 'Verify e-way bill validity or record the applicable exemption.'
                    : `Verify ${label(pending)} before approving entry.`,
              }
            : {
                tone: 'success' as const,
                title: 'All applicable documents verified',
                text: 'Approve only after security checks have passed.',
              },
  };
};

// ── vehicle numbers, masks, audit sanitizer ──

/** "ap 37 bc-2210" → "AP37BC2210" (letters + digits only). */
export const normalizeRegNo = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** "AP37BC2210" → "AP 37 BC 2210" (display; unknown formats returned as is). */
export const formatRegNo = (s: string): string => {
  const m = /^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{4})$/.exec(s);
  if (m === null) return s;
  return [m[1], m[2], m[3], m[4]].filter((p) => p !== undefined && p !== '').join(' ');
};

/** Indian mobile for display: "+91 98765 43210". */
export const formatMobile = (s: string | null): string | null => {
  if (s === null) return null;
  const d = s.replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `+91 ${d.slice(0, 5)} ${d.slice(5)}` : s;
};

/** Masked mobile for lists, passes and audit: "+91 98••• ••210". */
export const maskMobile = (s: string | null): string | null => {
  if (s === null) return null;
  const d = s.replace(/\D/g, '').slice(-10);
  if (d.length < 6) return '••••';
  return `+91 ${d.slice(0, 2)}••• ••${d.slice(-3)}`;
};

/** Document number with only the last 4 visible: "••••••2210". */
export const maskRef = (s: string | null): string | null =>
  s === null
    ? null
    : s.length <= 4
      ? '••••'
      : `${'•'.repeat(Math.min(s.length - 4, 8))}${s.slice(-4)}`;

/** Name → initials (retention): "Rajesh Kumar" → "R. K.". */
export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter((p) => p !== '')
    .map((p) => `${p.charAt(0).toUpperCase()}.`)
    .join(' ') || '—';

const MOBILE_KEYS = new Set(['driverMobile', 'mobile', 'plannedDriverMobile', 'phone']);
const REF_KEYS = new Set(['driverLicenceNo', 'licenceNo']);

/**
 * Masks driver / visitor PII in an audit payload BEFORE it is written (audit rows are
 * append-only and are never purged).
 */
export const sanitizeAudit = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map((v: unknown) => sanitizeAudit(v)) as T;
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  const o = value as Record<string, unknown>;
  const piiDoc = o.docType === 'DRIVER_LICENCE' || o.docType === 'RC_BOOK';
  for (const [k, v] of Object.entries(o)) {
    if (MOBILE_KEYS.has(k) && typeof v === 'string') out[k] = maskMobile(v);
    else if (REF_KEYS.has(k) && typeof v === 'string') out[k] = maskRef(v);
    else if (k === 'refNo' && piiDoc && typeof v === 'string') out[k] = maskRef(v);
    else out[k] = sanitizeAudit(v);
  }
  return out as T;
};

// ── CN link window ──

const LINKABLE: readonly EntryStatus[] = ['UNLOADING', 'UNLOADED', 'WEIGHED_OUT', 'PASS_OUT'];

/** A CN may be linked while the truck is between unloading and its outward pass (HELD too). */
export const canLinkReceipt = (e: EntryState): boolean =>
  LINKABLE.includes(e.status) ||
  (e.status === 'HELD' && e.pausedFromStatus !== null && LINKABLE.includes(e.pausedFromStatus));

// ── caching ──

/** ETag / cache-key minute bucket: time-based values (delayed, avg wait) refresh every minute. */
export const minuteBucket = (nowMs: number): number => Math.floor(nowMs / 60_000);

export const etagOf = (version: string, bucket: number, hash: string): string =>
  `W/"g${version}-${String(bucket)}-${hash}"`;

// ── settings ──

export interface GateSettings {
  'gate.weightTolerance': Tolerance;
  'gate.packagingAllowance': Record<Purpose, Allowance>;
  'gate.requiredDocs': Record<Purpose, DocType[]>;
  'gate.slotMinutes': number;
  'gate.delayGraceMinutes': number;
  'gate.grossRequired': boolean;
  'gate.exitCheckOnReject': boolean;
  'gate.passValidityHours': number;
  'gate.visitorRetentionDays': number;
  'gate.driverRetentionDays': number;
}

export const GATE_DEFAULTS: GateSettings = {
  'gate.weightTolerance': { pct: 0.5, minKg: 20 },
  'gate.packagingAllowance': {
    INBOUND_CONSIGNMENT: { pct: 1, perPalletKg: 25 },
    STOCK_TRANSFER: { pct: 1, perPalletKg: 25 },
    CUSTOMER_RETURN: { pct: 2, perPalletKg: 25 },
    OTHER: { pct: 1, perPalletKg: 25 },
  },
  'gate.requiredDocs': {
    INBOUND_CONSIGNMENT: ['PURCHASE_ORDER', 'DELIVERY_CHALLAN', 'EWAY_BILL'],
    STOCK_TRANSFER: ['DELIVERY_CHALLAN', 'EWAY_BILL'],
    CUSTOMER_RETURN: ['DELIVERY_CHALLAN'],
    OTHER: [],
  },
  'gate.slotMinutes': 90,
  'gate.delayGraceMinutes': 30,
  'gate.grossRequired': true,
  'gate.exitCheckOnReject': true,
  'gate.passValidityHours': 24,
  'gate.visitorRetentionDays': 90,
  'gate.driverRetentionDays': 180,
};

export const GATE_SETTING_KEYS = Object.keys(GATE_DEFAULTS) as (keyof GateSettings)[];
