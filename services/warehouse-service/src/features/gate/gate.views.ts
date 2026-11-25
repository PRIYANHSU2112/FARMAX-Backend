import { num } from '../../middleware/http.js';
import type {
  DocumentRow,
  EntryRow,
  EventRow,
  PassRow,
  ShipmentListRow,
  ShipmentRow,
  WeighmentRow,
} from './gate.repository.js';
import {
  DOC_LABEL,
  type EntryStatus,
  type Pause,
  STAGE_LABEL,
  formatMobile,
  formatRegNo,
  maskMobile,
  maskRef,
  stepsOf,
  tabOf,
} from './gate.rules.js';

export const VEHICLE_TYPE_LABEL: Record<string, string> = {
  MINI_TRUCK: 'Mini truck',
  LCV: 'Light commercial vehicle',
  TRUCK: 'Truck',
  HEAVY_TRUCK: 'Heavy Commercial Truck (6-Wheeler+)',
  MULTI_AXLE: 'Multi-axle truck',
  REEFER: 'Reefer truck',
  TRACTOR_TRAILER: 'Tractor trailer',
  OTHER: 'Other vehicle',
};

export const PURPOSE_LABEL: Record<string, string> = {
  INBOUND_CONSIGNMENT: 'Inbound consignment',
  STOCK_TRANSFER: 'Stock transfer',
  CUSTOMER_RETURN: 'Customer return',
  OTHER: 'Other',
};

export const ENTRY_STATUS_LABEL: Record<EntryStatus, string> = {
  ARRIVED: 'Arrived · awaiting gross weight',
  WEIGHED_IN: 'Weighed in · awaiting verification',
  APPROVED: 'Approved · inward pass issued',
  UNLOADING: 'Unloading at bay',
  UNLOADED: 'Unloaded · awaiting tare',
  WEIGHED_OUT: 'Weighed out · awaiting outward pass',
  PASS_OUT: 'Outward pass issued · awaiting exit',
  BLOCKED: 'Blocked · awaiting corrected documents',
  HELD: 'Held · supervisor review',
  REJECTED: 'Turned away · awaiting exit',
  EXITED: 'Gate out · completed',
  CANCELLED: 'Cancelled',
};

export const EVENT_LABEL: Record<string, string> = {
  SHIPMENT_CREATED: 'Shipment created',
  SHIPMENT_UPDATED: 'Shipment updated',
  SHIPMENT_CANCELLED: 'Shipment cancelled',
  APPOINTMENT_BOOKED: 'Dock appointment booked',
  APPOINTMENT_RESCHEDULED: 'Dock appointment rescheduled',
  GATE_IN: 'Gate in',
  GROSS_CAPTURED: 'Gross weight captured',
  DOC_ATTACHED: 'Document attached',
  DOC_VERIFIED: 'Document verified',
  DOC_REJECTED: 'Document rejected',
  DOC_EXEMPTED: 'Document exemption recorded',
  ENTRY_APPROVED: 'Gate entry approved',
  ENTRY_BLOCKED: 'Entry blocked',
  ENTRY_UNBLOCKED: 'Entry unblocked',
  TURNED_AWAY: 'Turned away',
  HANDOVER: 'Handed over to receiving',
  CN_LINKED: 'Goods receipt linked',
  UNLOADED: 'Unloading complete',
  TARE_CAPTURED: 'Tare weight captured',
  HELD: 'Weight hold',
  HOLD_RESOLVED: 'Hold resolved',
  OVERRIDE_REQUESTED: 'Manual weighment for review',
  OVERRIDE_APPROVED: 'Manual weighment approved',
  OVERRIDE_REJECTED: 'Manual weighment rejected',
  EXIT_CHECK: 'Exit weight check',
  SECURITY_HOLD: 'Security hold',
  SECURITY_CLEAR: 'Security check cleared',
  PASS_IN_ISSUED: 'Inward gate pass issued',
  PASS_OUT_ISSUED: 'Outward gate pass issued',
  PASS_REISSUED: 'Gate pass reissued',
  PASS_VOIDED: 'Gate pass voided',
  GATE_OUT: 'Gate out',
  ENTRY_CANCELLED: 'Gate entry cancelled',
};

const iso = (d: Date | null | undefined): string | null => (d == null ? null : d.toISOString());
const kg = (d: { toString(): string } | null): number | null =>
  d === null ? null : Number(num(d).toFixed(2));
const ymd = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));

export const sizeLabel = (bytes: number | null): string | null => {
  if (bytes === null) return null;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
};

/** "5.62 MT" from kg. */
export const tonnes = (kgValue: number | null): string | null =>
  kgValue === null ? null : `${(kgValue / 1000).toFixed(2)} MT`;

/** W5.01 table row (driver data never in lists). */
export const shipmentListItem = (s: ShipmentListRow, now: Date) => {
  const stage = s.stage;
  return {
    id: s.id,
    shipmentNo: s.shipmentNo,
    poRef: s.restockRequestNo ?? s.vendorPoNo,
    vendor: { id: s.vendorId, code: s.vendorCode, name: s.vendorName },
    purpose: s.purpose,
    vehicleRegNo: s.vehicleRegNo,
    vehicleDisplay: s.vehicleRegNo === null ? null : formatRegNo(s.vehicleRegNo),
    payloadLabel: s.payloadLabel,
    totalUnits: s.totalUnits,
    etaAt: s.etaAt.toISOString(),
    delayed: stage === 'EXPECTED' && s.etaAt < now,
    bay: { dockDoorId: s.dockDoorId, code: s.bayCode },
    stage,
    stageLabel: STAGE_LABEL[stage],
    tab: tabOf(stage),
    activeEntryId: s.activeEntryId,
    rebookingRequired: s.rebookingRequired,
    attemptNo: s.attemptNo,
    actions: {
      view: true,
      edit: stage === 'EXPECTED',
      delete: stage === 'EXPECTED',
    },
  };
};

export const lineView = (l: ShipmentRow['lines'][number]) => ({
  lineNo: l.lineNo,
  variantId: l.variantId,
  sku: l.sku,
  name: l.name,
  packLabel: l.packLabel,
  expectedQty: l.expectedQty,
  unitWeightKg: l.unitWeightGrams === null ? null : l.unitWeightGrams / 1000,
  declaredNetKg: kg(l.declaredNetKg),
  declaredNetMt: tonnes(kg(l.declaredNetKg)),
});

export const manifestOf = (s: ShipmentRow) => {
  const lines = s.lines.map(lineView);
  const declared = kg(s.declaredNetKg);
  return {
    lines,
    totals: {
      lineCount: lines.length,
      totalUnits: s.totalUnits,
      estimatedWeightKg: declared,
      estimatedWeightMt: tonnes(declared),
      weightComplete: lines.every((l) => l.declaredNetKg !== null),
    },
  };
};

/** W5.04 review / W5.08 shipment card (full driver mobile: authorised detail screen). */
export const shipmentView = (s: ShipmentRow, now: Date) => {
  const stage = s.stage;
  const mins = Math.round((s.etaAt.getTime() - now.getTime()) / 60_000);
  return {
    ...shipmentListItem(s, now),
    purposeLabel: PURPOSE_LABEL[s.purpose],
    restockRequestId: s.restockRequestId,
    restockRequestNo: s.restockRequestNo,
    vendorPoNo: s.vendorPoNo,
    transferId: s.transferId,
    asnId: s.asnId,
    sourceLocation: s.sourceLocation,
    transportType: s.transportType,
    transportTypeLabel: VEHICLE_TYPE_LABEL[s.transportType] ?? s.transportType,
    plannedVehicleRegNo: s.plannedVehicleRegNo,
    plannedDriver: {
      name: s.plannedDriverName,
      mobile: formatMobile(s.plannedDriverMobile),
    },
    etaWithinMins: stage === 'EXPECTED' && mins >= 0 && mins <= 60 ? mins : null,
    dockBookingId: s.dockBookingId,
    invoiceNetKg: kg(s.invoiceNetKg),
    invoiceGrossKg: kg(s.invoiceGrossKg),
    palletCount: s.palletCount,
    notes: s.notes,
    cancelledAt: iso(s.cancelledAt),
    cancelReason: s.cancelReason,
    version: s.version,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
};

export const pauseOf = (e: EntryRow): Pause | null =>
  e.status === 'BLOCKED'
    ? { kind: 'BLOCKED', reason: e.blockReason, since: iso(e.blockedAt) }
    : e.status === 'HELD'
      ? { kind: 'HELD', reason: e.holdReason, since: iso(e.heldAt) }
      : null;

export const entrySteps = (e: EntryRow | null) =>
  e === null
    ? stepsOf(null)
    : stepsOf(
        {
          status: e.status,
          pausedFromStatus: e.pausedFromStatus,
          outcome: e.outcome,
        },
        pauseOf(e),
      );

/** Gate entry detail (W5.05 / W5.06 header / W5.08). */
export const entryView = (
  e: EntryRow,
  extra: { shipmentNo: string; lastTare?: { tareKg: unknown; entryNo: string } | null },
) => ({
  id: e.id,
  entryNo: e.entryNo,
  shipmentId: e.shipmentId,
  shipmentNo: extra.shipmentNo,
  warehouseId: e.warehouseId,
  vehicleRegNo: e.vehicleRegNo,
  vehicleDisplay: formatRegNo(e.vehicleRegNo),
  vehicleType: e.vehicleType,
  vehicleTypeLabel: VEHICLE_TYPE_LABEL[e.vehicleType] ?? e.vehicleType,
  driver: {
    name: e.driverName,
    mobile: e.piiRedactedAt === null ? formatMobile(e.driverMobile) : e.driverMobile,
    licenceNo: maskRef(e.driverLicenceNo),
    verified: e.driverVerified,
  },
  plateMatched: e.plateMatched,
  plateNote: e.plateNote,
  arrivedAt: e.arrivedAt.toISOString(),
  bay: { dockDoorId: e.dockDoorId, code: e.bayCode },
  status: e.status,
  statusLabel: ENTRY_STATUS_LABEL[e.status],
  pausedFromStatus: e.pausedFromStatus,
  outcome: e.outcome,
  weights: {
    grossKg: kg(e.grossKg),
    grossAt: iso(e.grossAt),
    tareKg: kg(e.tareKg),
    tareAt: iso(e.tareAt),
    netKg: kg(e.netKg),
    expectedLoadKg: kg(e.expectedLoadKg),
    packagingAllowanceKg: kg(e.packagingAllowanceKg),
    varianceKg: kg(e.varianceKg),
    toleranceKg: kg(e.toleranceKg),
    basis: e.reconBasis,
    result: e.reconResult,
    exitCheckKg: kg(e.exitCheckKg),
    exitCheckResult: e.exitCheckResult,
    tareOnRecord:
      extra.lastTare === undefined || extra.lastTare === null
        ? null
        : { tareKg: kg(extra.lastTare.tareKg as never), entryNo: extra.lastTare.entryNo },
  },
  block:
    e.blockReason === null
      ? null
      : {
          reason: e.blockReason,
          holdLocation: e.blockHoldLocation,
          remarks: e.blockRemarks,
          at: iso(e.blockedAt),
          nextAction: 'Re-verify before issuing gate pass',
        },
  hold:
    e.holdReason === null
      ? null
      : {
          reason: e.holdReason,
          note: e.holdNote,
          at: iso(e.heldAt),
          resolution: e.holdResolution,
          resolvedAt: iso(e.holdResolvedAt),
        },
  rejection:
    e.rejectedAt === null
      ? null
      : {
          reason: e.rejectionReason,
          shipmentAction: e.pendingShipmentAction,
          at: iso(e.rejectedAt),
          appliedAt: iso(e.shipmentActionAppliedAt),
        },
  approval: e.approvedAt === null ? null : { at: iso(e.approvedAt), remarks: e.approvalRemarks },
  receiving: {
    rcvNo: e.rcvNo,
    handoverAt: iso(e.handoverAt),
    unloadedAt: iso(e.unloadedAt),
    dockInAt: iso(e.dockInAt),
    dockOutAt: iso(e.dockOutAt),
    noReceipt: e.noReceipt,
    noReceiptReason: e.noReceiptReason,
  },
  debitNoteRequired: e.debitNoteRequired,
  passOutAt: iso(e.passOutAt),
  exitedAt: iso(e.exitedAt),
  cancelledAt: iso(e.cancelledAt),
  stepBar: entrySteps(e),
  liveRoute: { status: 'NOT_AVAILABLE' as const },
  version: e.version,
});

export const docView = (d: DocumentRow, today: string) => {
  const type = d.docType;
  const expired = d.expired || (ymd(d.validUntil) ?? '9999-12-31') < today;
  const pii = type === 'DRIVER_LICENCE' || type === 'RC_BOOK';
  return {
    id: d.id,
    docType: type,
    label: DOC_LABEL[type],
    refNo: pii ? maskRef(d.refNo) : d.refNo,
    validUntil: ymd(d.validUntil),
    fileName: d.fileName,
    sizeBytes: d.sizeBytes,
    sizeLabel: sizeLabel(d.sizeBytes),
    contentType: d.contentType,
    hasFile: d.mediaKey !== null,
    mediaPurged: d.mediaPurgedAt !== null,
    status: d.status,
    required: d.required,
    expired,
    carriedForward: d.carriedForward,
    note: d.note,
    uploadedAt: d.uploadedAt.toISOString(),
    verifiedAt: iso(d.verifiedAt),
    verifiedBy: d.verifiedBy,
    action: d.status === 'PENDING' || expired ? ('VERIFY' as const) : ('PREVIEW' as const),
    version: d.version,
  };
};

export const weighmentView = (w: WeighmentRow, scaleCode: string | null) => ({
  id: w.id,
  kind: w.kind,
  kindLabel:
    w.kind === 'GROSS'
      ? 'Second Weight (Gross)'
      : w.kind === 'TARE'
        ? 'First Weight (Tare)'
        : 'Exit weight check',
  badge: w.kind === 'GROSS' || w.kind === 'EXIT_CHECK' ? 'LOADED' : 'EMPTY',
  weightKg: kg(w.weightKg),
  method: w.method,
  scale: { id: w.scaleId, code: scaleCode },
  slipNo: w.slipNo,
  hasSlip: w.slipMediaKey !== null,
  status: w.status,
  reason: w.reason,
  capturedAt: w.capturedAt.toISOString(),
  capturedBy: w.capturedBy,
  reviewedAt: iso(w.reviewedAt),
  reviewedBy: w.reviewedBy,
  reviewNote: w.reviewNote,
  supersedesId: w.supersedesId,
});

export const passView = (p: PassRow, qrToken: string | null) => ({
  id: p.id,
  passNo: p.passNo,
  type: p.type,
  title: p.type === 'INWARD' ? 'Inward gate pass' : 'Outward gate pass',
  status: p.status,
  outcome: p.outcome,
  issuedAt: p.issuedAt.toISOString(),
  issuedBy: p.issuedBy,
  expiresAt: p.expiresAt.toISOString(),
  usedAt: iso(p.usedAt),
  voidedAt: iso(p.voidedAt),
  voidReason: p.voidReason,
  replacedById: p.replacedById,
  reissueOfId: p.reissueOfId,
  snapshot: p.snapshot,
  qrToken,
});

export const eventView = (e: EventRow) => ({
  id: e.id,
  type: e.type,
  label: EVENT_LABEL[e.type] ?? e.type,
  at: e.at.toISOString(),
  byUserId: e.byUserId,
  data: e.data,
});

/** Masked mobile for lists / passes. */
export { maskMobile };
