import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { Caller } from '../../middleware/guards.js';
import { num } from '../../middleware/http.js';
import { isOverlapViolation } from '../docks/index.js';
import type { WarehouseRecord } from '../warehouses/index.js';
import type { EntryRow, ShipmentRow } from './gate.repository.js';
import {
  type Action,
  type EntryStatus,
  type GateSettings,
  canLinkReceipt,
  checklist,
  formatRegNo,
  normalizeRegNo,
  transition,
} from './gate.rules.js';
import { conflict, stale, isDuplicate } from './gate.support.js';
import { docView, entryView, eventView } from './gate.views.js';

export interface EntryInput {
  shipmentId: string;
  vehicleRegNo: string;
  vehicleType: string;
  driverName: string;
  driverMobile: string;
  driverLicenceNo?: string | null;
  driverVerified?: boolean;
  arrivedAt?: string;
  dockDoorId?: string | null;
  plateNote?: string | null;
  gross?: {
    weightKg: number;
    scaleId?: string | null;
    slipNo?: string | null;
    slipReceipt?: string | null;
  };
}

export interface EntryPatch {
  expectedVersion: number;
  vehicleRegNo?: string;
  vehicleType?: string;
  driverName?: string;
  driverMobile?: string;
  driverLicenceNo?: string | null;
  driverVerified?: boolean;
  dockDoorId?: string | null;
  plateNote?: string | null;
}

const ymd = (d: Date | null) => (d === null ? null : d.toISOString().slice(0, 10));

/**
 * Gate entries (W5.05–W5.08, D-62): gate-in, documents, approve / block / unblock / turn-away,
 * receiving handover, unloading (CN link or manual + reason), timeline. Every status move is a
 * state-guarded update (§1a) mirrored on the shipment, with a timeline row, a masked audit row and
 * the outbox status event in the same transaction; the gate cache version is bumped after commit.
 */
export class GateEntriesService {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'gateRepository'
      | 'gateSupport'
      | 'gateShipments'
      | 'gateWeighbridge'
      | 'gatePasses'
      | 'docksService'
      | 'runInTransaction'
    >,
  ) {}

  private get repo() {
    return this.deps.gateRepository;
  }
  private get support() {
    return this.deps.gateSupport;
  }

  /** Entry visible to the caller (404 outside scope) + its warehouse. */
  async load(caller: Caller, id: string, key = 'gate.view') {
    const e = await this.repo.entry(id);
    if (e === null) throw new NotFoundError('Gate entry');
    const w = await this.support.warehouse(caller, e.warehouseId, key);
    return { e, w };
  }

  async out(id: string) {
    const e = await this.repo.entry(id);
    if (e === null) throw new NotFoundError('Gate entry');
    const [s, lastTare] = await Promise.all([
      this.repo.shipment(e.shipmentId),
      this.repo.lastTare(e.vehicleRegNo),
    ]);
    return entryView(e, { shipmentNo: s?.shipmentNo ?? '', lastTare });
  }

  async view(caller: Caller, id: string) {
    await this.load(caller, id);
    return this.out(id);
  }

  /**
   * Applies one §1a action under the entry row lock: guard → update → shipment mirror + outbox
   * event → timeline + audit. Returns the updated entry.
   */
  async move(
    tx: Tx,
    caller: Caller | null,
    locked: EntryRow,
    action: Action,
    data: Record<string, unknown>,
    event: { type: string; data?: Record<string, unknown> },
    audit: { action: string; reason?: string | null; after?: object },
  ): Promise<EntryRow> {
    const t = transition(action, {
      status: locked.status,
      pausedFromStatus: locked.pausedFromStatus,
    });
    if (!t.ok) throw stale(locked.status);
    const updated = await this.repo.guardedUpdate(tx, locked.id, [locked.status], {
      ...data,
      status: t.to,
      pausedFromStatus: t.pausedFromStatus,
    });
    if (updated === null) throw stale(locked.status);
    await this.support.syncEntry(tx, updated, locked.status);
    await this.support.event(tx, {
      warehouseId: locked.warehouseId,
      shipmentId: locked.shipmentId,
      gateEntryId: locked.id,
      type: event.type,
      byUserId: caller?.userId ?? null,
      data: {
        entryNo: locked.entryNo,
        vehicleRegNo: locked.vehicleRegNo,
        bay: locked.bayCode,
        ...event.data,
      },
    });
    await this.support.audit(
      tx,
      caller,
      audit.action,
      'gate_entry',
      locked.id,
      { status: t.to, ...audit.after },
      { status: locked.status },
      audit.reason ?? null,
    );
    return updated;
  }

  // ── W5.05 gate entry ──

  async arrivals(caller: Caller, warehouseId: string, q: string | undefined, limit: number) {
    const w = await this.support.warehouse(caller, warehouseId, 'gate.view');
    const today = this.support.today(w);
    const from = new Date(today.from.getTime() - 24 * 3600_000);
    const to = new Date(today.to.getTime() + 24 * 3600_000);
    const rows = await this.repo.arrivals(w.id, from, to, q, limit);
    return rows.map((s) => ({
      id: s.id,
      shipmentNo: s.shipmentNo,
      poRef: s.restockRequestNo ?? s.vendorPoNo,
      vendor: { id: s.vendorId, code: s.vendorCode, name: s.vendorName },
      etaAt: s.etaAt.toISOString(),
      plannedVehicleRegNo: s.plannedVehicleRegNo,
      vehicleDisplay: s.plannedVehicleRegNo === null ? null : formatRegNo(s.plannedVehicleRegNo),
      transportType: s.transportType,
      plannedDriverName: s.plannedDriverName,
      plannedDriverMobile: s.plannedDriverMobile,
      bay: { dockDoorId: s.dockDoorId, code: s.bayCode },
      payloadLabel: s.payloadLabel,
      rebookingRequired: s.rebookingRequired,
    }));
  }

  /** Inbound door of the warehouse or 422. */
  private async door(warehouseId: string, doorId: string | null) {
    if (doorId === null) return null;
    const d = (await this.deps.docksService.inboundDoors(warehouseId)).find((x) => x.id === doorId);
    if (d === undefined)
      throw new ValidationError([
        { path: 'body.dockDoorId', message: 'is not an active unloading door' },
      ]);
    return d;
  }

  async create(caller: Caller, input: EntryInput, idempotencyKey: string | null) {
    const shipment = await this.repo.shipment(input.shipmentId);
    if (shipment === null) throw new NotFoundError('Inbound shipment');
    const w = await this.support.warehouse(caller, shipment.warehouseId, 'gate.operate');
    if (idempotencyKey !== null) {
      const hit = await this.repo.entryByKey(idempotencyKey);
      if (hit !== null) return this.gateIn(hit.id, w);
    }
    if (shipment.rebookingRequired)
      throw conflict(
        'REBOOKING_REQUIRED',
        'Book a new dock slot for this re-delivery before gate-in',
      );
    const regNo = normalizeRegNo(input.vehicleRegNo);
    if (regNo.length < 4)
      throw new ValidationError([
        { path: 'body.vehicleRegNo', message: 'is not a vehicle number' },
      ]);
    const planned = shipment.plannedVehicleRegNo;
    const plateMatched = planned === null || planned === regNo;
    if (!plateMatched && (input.plateNote ?? '').trim().length < 5)
      throw new ValidationError([
        {
          path: 'body.plateNote',
          message: `vehicle ${formatRegNo(regNo)} is not the planned ${formatRegNo(planned)}; record why`,
        },
      ]);
    const now = new Date();
    const arrivedAt = input.arrivedAt === undefined ? now : new Date(input.arrivedAt);
    if (
      arrivedAt.getTime() > now.getTime() + 5 * 60_000 ||
      arrivedAt.getTime() < now.getTime() - 24 * 3600_000
    )
      throw new ValidationError([
        { path: 'body.arrivedAt', message: 'must be within the last 24 hours' },
      ]);
    const door = await this.door(w.id, input.dockDoorId ?? shipment.dockDoorId);
    const settings = await this.support.settings(w.id);
    try {
      const id = await this.deps.runInTransaction(async (tx) => {
        const s = await this.repo.lockShipment(tx, shipment.id);
        if (s === null) throw new NotFoundError('Inbound shipment');
        if (s.stage !== 'EXPECTED') throw stale(s.stage);
        if (s.rebookingRequired)
          throw conflict(
            'REBOOKING_REQUIRED',
            'Book a new dock slot for this re-delivery before gate-in',
          );
        const inside = await this.repo.activeEntryForVehicle(w.id, regNo, tx);
        if (inside !== null)
          throw conflict(
            'VEHICLE_INSIDE',
            `Vehicle ${formatRegNo(regNo)} is already inside (${inside.entryNo})`,
          );
        const entryNo = await this.support.nextNo(tx, 'GE');
        let e = await this.repo.createEntry(tx, {
          entryNo,
          warehouseId: w.id,
          shipmentId: s.id,
          vehicleRegNo: regNo,
          vehicleType: input.vehicleType as never,
          driverName: input.driverName,
          driverMobile: input.driverMobile,
          driverLicenceNo: input.driverLicenceNo ?? null,
          driverVerified: input.driverVerified ?? false,
          plateMatched,
          plateNote: input.plateNote ?? null,
          arrivedAt,
          dockDoorId: door?.id ?? null,
          bayCode: door?.code ?? null,
          idempotencyKey,
          createdBy: caller.userId,
        });
        await this.support.syncEntry(tx, e, null, s);
        await this.support.event(tx, {
          warehouseId: w.id,
          shipmentId: s.id,
          gateEntryId: e.id,
          type: 'GATE_IN',
          byUserId: caller.userId,
          at: arrivedAt,
          data: { entryNo, vehicleRegNo: regNo, bay: door?.code ?? null, plateMatched },
        });
        await this.support.audit(tx, caller, 'gate.entry_created', 'gate_entry', e.id, {
          entryNo,
          shipmentId: s.id,
          vehicleRegNo: regNo,
          driverName: input.driverName,
          driverMobile: input.driverMobile,
          plateMatched,
        });
        if (input.gross !== undefined)
          e = await this.deps.gateWeighbridge.captureInTx(tx, caller, e, w, settings, {
            kind: 'GROSS',
            ...input.gross,
          });
        return e.id;
      });
      await this.support.bump(w.id);
      return await this.gateIn(id, w);
    } catch (error) {
      if (idempotencyKey !== null && isDuplicate(error)) {
        const hit = await this.repo.entryByKey(idempotencyKey);
        if (hit !== null) return this.gateIn(hit.id, w);
      }
      if (isDuplicate(error)) {
        if ((await this.repo.activeEntryForVehicle(w.id, regNo)) !== null)
          throw conflict('VEHICLE_INSIDE', `Vehicle ${formatRegNo(regNo)} is already inside`);
        throw conflict('ENTRY_EXISTS', 'This shipment already has a vehicle at the gate');
      }
      throw error;
    }
  }

  /** W5.05a Gate-In confirmation. */
  private async gateIn(id: string, w: WarehouseRecord) {
    const entry = await this.out(id);
    return {
      entry,
      confirmation: {
        title: 'Gate-In Successful!',
        vehicleNo: entry.vehicleDisplay,
        driver: entry.driver.name,
        at: entry.arrivedAt,
        destinationBay: entry.bay.code,
        warehouse: { id: w.id, code: w.code, name: w.name },
        next: entry.weights.grossKg === null ? 'GROSS_WEIGHT' : 'DOCUMENTS',
      },
    };
  }

  async patch(caller: Caller, id: string, input: EntryPatch) {
    const { e, w } = await this.load(caller, id, 'gate.operate');
    const regNo = input.vehicleRegNo === undefined ? undefined : normalizeRegNo(input.vehicleRegNo);
    const door =
      input.dockDoorId === undefined ? undefined : await this.door(w.id, input.dockDoorId);
    try {
      await this.deps.runInTransaction(async (tx) => {
        const cur = await this.repo.lockEntry(tx, id);
        if (cur === null) throw new NotFoundError('Gate entry');
        if (cur.version !== input.expectedVersion)
          throw new ConflictError('The gate entry was changed by someone else; reload it', {
            details: { reason: 'VERSION_CONFLICT', currentVersion: cur.version },
          });
        const editable: EntryStatus[] = ['ARRIVED', 'WEIGHED_IN', 'BLOCKED'];
        if (!editable.includes(cur.status)) throw stale(cur.status);
        const s = await this.repo.shipment(cur.shipmentId, tx);
        const planned = s?.plannedVehicleRegNo ?? null;
        const nextReg = regNo ?? cur.vehicleRegNo;
        const plateMatched = planned === null || planned === nextReg;
        const note = input.plateNote === undefined ? cur.plateNote : input.plateNote;
        if (!plateMatched && (note ?? '').trim().length < 5)
          throw new ValidationError([
            { path: 'body.plateNote', message: 'record why the vehicle differs from the plan' },
          ]);
        const updated = await this.repo.guardedUpdate(tx, id, editable, {
          ...(regNo === undefined ? {} : { vehicleRegNo: regNo }),
          ...(input.vehicleType === undefined ? {} : { vehicleType: input.vehicleType as never }),
          ...(input.driverName === undefined ? {} : { driverName: input.driverName }),
          ...(input.driverMobile === undefined ? {} : { driverMobile: input.driverMobile }),
          ...(input.driverLicenceNo === undefined
            ? {}
            : { driverLicenceNo: input.driverLicenceNo }),
          ...(input.driverVerified === undefined ? {} : { driverVerified: input.driverVerified }),
          ...(door === undefined
            ? {}
            : { dockDoorId: door?.id ?? null, bayCode: door?.code ?? null }),
          plateMatched,
          plateNote: note,
        });
        if (updated === null) throw stale(cur.status);
        await this.support.syncEntry(tx, updated, cur.status, s);
        await this.support.audit(
          tx,
          caller,
          'gate.entry_updated',
          'gate_entry',
          id,
          { ...input },
          {
            vehicleRegNo: cur.vehicleRegNo,
            driverName: cur.driverName,
            driverMobile: cur.driverMobile,
          },
        );
      });
    } catch (error) {
      if (isDuplicate(error)) throw conflict('VEHICLE_INSIDE', 'That vehicle is already inside');
      throw error;
    }
    await this.support.bump(e.warehouseId);
    return this.out(id);
  }

  async cancel(caller: Caller, id: string, reason: string) {
    const { e } = await this.load(caller, id, 'gate.operate');
    await this.deps.runInTransaction(async (tx) => {
      const cur = await this.repo.lockEntry(tx, id);
      if (cur === null) throw new NotFoundError('Gate entry');
      await this.move(
        tx,
        caller,
        cur,
        'CANCEL',
        { cancelledAt: new Date(), cancelReason: reason },
        { type: 'ENTRY_CANCELLED' },
        { action: 'gate.entry_cancelled', reason },
      );
    });
    await this.support.bump(e.warehouseId);
    return this.out(id);
  }

  // ── W5.06 documents ──

  async documents(caller: Caller, id: string) {
    const { e, w } = await this.load(caller, id);
    const [s, docs, settings] = await Promise.all([
      this.repo.shipment(e.shipmentId),
      this.repo.documentsOf(e.shipmentId),
      this.support.settings(w.id),
    ]);
    if (s === null) throw new NotFoundError('Inbound shipment');
    const today = this.support.today(w).date;
    const required = settings['gate.requiredDocs'][s.purpose];
    const list = checklist(
      required,
      docs.map((d) => ({
        docType: d.docType,
        status: d.status,
        required: d.required,
        validUntil: ymd(d.validUntil),
      })),
      today,
    );
    return {
      header: {
        shipmentId: s.id,
        shipmentNo: s.shipmentNo,
        entryNo: e.entryNo,
        vehicleDisplay: formatRegNo(e.vehicleRegNo),
        driverName: e.driverName,
        warehouse: { id: w.id, name: w.name, code: w.code },
        bay: e.bayCode,
        grossKg: e.grossKg === null ? null : num(e.grossKg),
        poRef: s.restockRequestNo ?? s.vendorPoNo,
        status: e.status,
      },
      kpis: {
        requiredFiles: { value: list.required, caption: list.requiredLabel },
        verified: { value: list.verified, caption: list.verifiedLabel },
        pending: { value: list.pending, caption: list.pendingLabel },
        blocked: { value: list.blocked, caption: list.blockedLabel },
      },
      clearance: {
        complete: list.complete,
        ewayExpired: list.ewayExpired,
        missing: list.missing,
        hint: list.hint,
      },
      items: docs.map((d) => docView(d, today)),
    };
  }

  async verifyDocument(
    caller: Caller,
    docId: string,
    input: {
      decision: 'VERIFIED' | 'REJECTED' | 'EXEMPTED';
      refNo?: string | null;
      validUntil?: string | null;
      note?: string | null;
    },
  ) {
    const d0 = await this.repo.document(docId);
    if (d0 === null) throw new NotFoundError('Document');
    const s0 = await this.deps.gateShipments.load(caller, d0.shipmentId, 'gate.operate');
    const w = await this.support.warehouse(caller, s0.warehouseId, 'gate.operate');
    const today = this.support.today(w).date;
    if (input.decision !== 'VERIFIED' && (input.note ?? '').trim().length < 5)
      throw new ValidationError([
        { path: 'body.note', message: 'give the reason (≥ 5 characters)' },
      ]);
    const doc = await this.deps.runInTransaction(async (tx) => {
      const d = await this.repo.lockDocument(tx, docId);
      if (d === null) throw new NotFoundError('Document');
      const s = await this.repo.lockShipment(tx, d.shipmentId);
      if (s === null) throw new NotFoundError('Inbound shipment');
      if (s.stage === 'COMPLETED' || s.stage === 'CANCELLED')
        throw conflict('STALE_STATE', 'The shipment is closed');
      const validUntil =
        input.validUntil === undefined ? ymd(d.validUntil) : (input.validUntil ?? null);
      if (input.decision === 'VERIFIED' && d.docType === 'EWAY_BILL') {
        if (validUntil === null)
          throw new ValidationError([
            { path: 'body.validUntil', message: 'is required for an e-way bill' },
          ]);
        if (validUntil < today)
          throw conflict('EWAY_BILL_EXPIRED', `The e-way bill expired on ${validUntil}`);
      }
      const updated = await this.repo.updateDocument(tx, docId, {
        status: input.decision,
        ...(input.refNo === undefined ? {} : { refNo: input.refNo }),
        validUntil: validUntil === null ? null : new Date(`${validUntil}T00:00:00.000Z`),
        expired: false,
        note: input.note ?? d.note,
        verifiedBy: caller.userId,
        verifiedAt: new Date(),
        gateEntryId: s.activeEntryId ?? d.gateEntryId,
      });
      await this.support.event(tx, {
        warehouseId: s.warehouseId,
        shipmentId: s.id,
        gateEntryId: s.activeEntryId,
        type:
          input.decision === 'VERIFIED'
            ? 'DOC_VERIFIED'
            : input.decision === 'REJECTED'
              ? 'DOC_REJECTED'
              : 'DOC_EXEMPTED',
        byUserId: caller.userId,
        data: { docId, docType: d.docType },
      });
      await this.support.audit(
        tx,
        caller,
        'gate.document_' + input.decision.toLowerCase(),
        'gate_document',
        docId,
        { docType: d.docType, status: input.decision, refNo: input.refNo ?? d.refNo, validUntil },
        { status: d.status },
        input.note ?? null,
      );
      return updated;
    });
    await this.support.bump(s0.warehouseId);
    return docView(doc, today);
  }

  /** Verified / exempted required docs, e-way bill in date (re-checked on every approval). */
  private async assertDocs(tx: Tx, s: ShipmentRow, w: WarehouseRecord, settings: GateSettings) {
    const docs = await this.repo.documentsOf(s.id, tx);
    const list = checklist(
      settings['gate.requiredDocs'][s.purpose],
      docs.map((d) => ({
        docType: d.docType,
        status: d.status,
        required: d.required,
        validUntil: ymd(d.validUntil),
      })),
      this.support.today(w).date,
    );
    if (list.ewayExpired) throw conflict('EWAY_BILL_EXPIRED', 'The e-way bill has expired');
    if (!list.complete)
      throw conflict('DOCS_INCOMPLETE', 'Verify every required document first', {
        missing: list.missing,
      });
  }

  /** W5.06b Approve entry → APPROVED + inward gate pass (one transaction). */
  async approve(
    caller: Caller,
    id: string,
    input: {
      remarks?: string | null;
      driverVerified?: boolean;
      ewayBill?: { refNo: string; validUntil: string } | null;
    },
  ) {
    const { e, w } = await this.load(caller, id, 'gate.approve');
    const settings = await this.support.settings(w.id);
    await this.deps.runInTransaction(async (tx) => {
      const cur = await this.repo.lockEntry(tx, id);
      if (cur === null) throw new NotFoundError('Gate entry');
      const s = await this.repo.lockShipment(tx, cur.shipmentId);
      if (s === null) throw new NotFoundError('Inbound shipment');
      if (!['ARRIVED', 'WEIGHED_IN'].includes(cur.status)) throw stale(cur.status);
      if (settings['gate.grossRequired'] && cur.grossKg === null)
        throw conflict('GROSS_REQUIRED', 'Capture the gross weight before approving entry');
      if (await this.repo.hasPendingWeighment(tx, id))
        throw conflict('OVERRIDE_PENDING', 'A manual weighment is waiting for review');
      if (input.ewayBill !== undefined && input.ewayBill !== null) {
        const today = this.support.today(w).date;
        if (input.ewayBill.validUntil < today)
          throw conflict(
            'EWAY_BILL_EXPIRED',
            `The e-way bill expired on ${input.ewayBill.validUntil}`,
          );
        const docs = await this.repo.documentsOf(s.id, tx);
        const eway = docs.find((d) => d.docType === 'EWAY_BILL' && d.status !== 'REJECTED');
        const data = {
          refNo: input.ewayBill.refNo,
          validUntil: new Date(`${input.ewayBill.validUntil}T00:00:00.000Z`),
          status: 'VERIFIED' as const,
          expired: false,
          verifiedBy: caller.userId,
          verifiedAt: new Date(),
          gateEntryId: id,
        };
        if (eway === undefined)
          await this.repo.createDocument(tx, {
            shipmentId: s.id,
            warehouseId: s.warehouseId,
            docType: 'EWAY_BILL',
            required: true,
            uploadedBy: caller.userId,
            ...data,
          });
        else await this.repo.updateDocument(tx, eway.id, data);
      }
      await this.assertDocs(tx, s, w, settings);
      const moved = await this.move(
        tx,
        caller,
        cur,
        'APPROVE',
        {
          approvedAt: new Date(),
          approvedBy: caller.userId,
          approvalRemarks: input.remarks ?? null,
          ...(input.driverVerified === undefined ? {} : { driverVerified: input.driverVerified }),
        },
        { type: 'ENTRY_APPROVED' },
        { action: 'gate.entry_approved', reason: input.remarks ?? null },
      );
      await this.deps.gatePasses.issueInTx(tx, caller, moved, s, 'INWARD', w, settings);
    });
    await this.support.bump(e.warehouseId);
    return { entry: await this.out(id), passes: await this.deps.gatePasses.forEntry(id) };
  }

  /** W5.06c Block entry. */
  async block(
    caller: Caller,
    id: string,
    input: { reason: string; holdLocation?: string | null; remarks: string },
  ) {
    const { e, w } = await this.load(caller, id, 'gate.operate');
    await this.deps.runInTransaction(async (tx) => {
      const cur = await this.repo.lockEntry(tx, id);
      if (cur === null) throw new NotFoundError('Gate entry');
      await this.move(
        tx,
        caller,
        cur,
        'BLOCK',
        {
          blockReason: input.reason,
          blockHoldLocation: input.holdLocation ?? null,
          blockRemarks: input.remarks,
          blockedAt: new Date(),
          blockedBy: caller.userId,
        },
        { type: 'ENTRY_BLOCKED', data: { reason: input.reason } },
        { action: 'gate.entry_blocked', reason: input.remarks },
      );
    });
    await this.support.bump(e.warehouseId);
    const entry = await this.out(id);
    return {
      entry,
      blocked: {
        gateEntry: entry.entryNo,
        vehicle: entry.vehicleDisplay,
        status: 'Blocked · Awaiting corrected documents',
        nextAction: 'Re-verify before issuing gate pass',
        warehouse: w.name,
      },
    };
  }

  async unblock(caller: Caller, id: string, remarks: string) {
    const { e } = await this.load(caller, id, 'gate.approve');
    await this.deps.runInTransaction(async (tx) => {
      const cur = await this.repo.lockEntry(tx, id);
      if (cur === null) throw new NotFoundError('Gate entry');
      await this.move(
        tx,
        caller,
        cur,
        'UNBLOCK',
        {},
        { type: 'ENTRY_UNBLOCKED' },
        { action: 'gate.entry_unblocked', reason: remarks },
      );
    });
    await this.support.bump(e.warehouseId);
    return this.out(id);
  }

  /**
   * Turn-away (§1a, before unloading only): REJECTED + GP-IN VOID + dock booking released, in one
   * transaction. The shipment action (re-expect / cancel) waits for the exit.
   */
  async turnAway(
    caller: Caller,
    id: string,
    input: { reason: string; shipmentAction: 'REEXPECT' | 'CANCEL' },
  ) {
    const { e } = await this.load(caller, id, 'gate.approve');
    await this.deps.runInTransaction(async (tx) => {
      const cur = await this.repo.lockEntry(tx, id);
      if (cur === null) throw new NotFoundError('Gate entry');
      const s = await this.repo.lockShipment(tx, cur.shipmentId);
      if (s === null) throw new NotFoundError('Inbound shipment');
      await this.deps.gatePasses.voidLiveInTx(
        tx,
        caller,
        cur,
        'INWARD',
        `Turned away: ${input.reason}`,
      );
      if (s.dockBookingId !== null)
        await this.deps.docksService.gateMove(
          tx,
          s.warehouseId,
          s.dockBookingId,
          'cancel',
          caller.userId,
        );
      await this.move(
        tx,
        caller,
        cur,
        'TURN_AWAY',
        {
          outcome: 'REJECTED',
          rejectionReason: input.reason,
          pendingShipmentAction: input.shipmentAction,
          rejectedAt: new Date(),
          rejectedBy: caller.userId,
        },
        { type: 'TURNED_AWAY', data: { shipmentAction: input.shipmentAction } },
        {
          action: 'gate.entry_turned_away',
          reason: input.reason,
          after: { shipmentAction: input.shipmentAction },
        },
      );
    });
    await this.support.bump(e.warehouseId);
    return this.out(id);
  }

  // ── W5.07 receiving handover ──

  /** APPROVED → UNLOADING inside the caller's transaction (button or GP-IN scan). */
  async handoverInTx(tx: Tx, caller: Caller, cur: EntryRow): Promise<EntryRow> {
    const s = await this.repo.lockShipment(tx, cur.shipmentId);
    if (s === null) throw new NotFoundError('Inbound shipment');
    if (cur.status !== 'APPROVED') throw stale(cur.status);
    if (s.dockBookingId !== null)
      await this.deps.docksService.gateMove(
        tx,
        s.warehouseId,
        s.dockBookingId,
        'start',
        caller.userId,
      );
    const rcvNo = await this.support.nextNo(tx, 'RCV');
    await this.deps.gatePasses.useLiveInTx(tx, caller, cur, 'INWARD');
    return this.move(
      tx,
      caller,
      cur,
      'HANDOVER',
      { rcvNo, handoverAt: new Date(), handoverBy: caller.userId, dockInAt: new Date() },
      { type: 'HANDOVER', data: { rcvNo } },
      { action: 'gate.entry_handover', after: { rcvNo } },
    );
  }

  async handover(caller: Caller, id: string) {
    const { e } = await this.load(caller, id, 'gate.operate');
    try {
      await this.deps.runInTransaction(async (tx) => {
        const cur = await this.repo.lockEntry(tx, id);
        if (cur === null) throw new NotFoundError('Gate entry');
        await this.handoverInTx(tx, caller, cur);
      });
    } catch (error) {
      if (isOverlapViolation(error)) throw conflict('DOCK_BUSY', 'The dock door is busy');
      throw error;
    }
    await this.support.bump(e.warehouseId);
    return this.handoverView(id);
  }

  /** W5.07b Receiving handover modal. */
  async handoverView(id: string) {
    const entry = await this.out(id);
    const receipts = await this.repo.receiptsOf(id);
    return {
      entry,
      handover: {
        receivingReference: entry.receiving.rcvNo,
        shipmentNo: entry.shipmentNo,
        status:
          entry.status === 'UNLOADING'
            ? 'Unloading in progress'
            : entry.receiving.unloadedAt === null
              ? entry.statusLabel
              : 'Unloading complete',
        nextStep:
          entry.status === 'UNLOADING'
            ? 'Post the goods receipt (CN) or mark unloading complete'
            : 'Capture empty-vehicle tare at exit',
        receipts: receipts.map((r) => ({
          cnNo: r.cnNo,
          finalForGate: r.finalForGate,
          attachedAt: r.attachedAt.toISOString(),
        })),
      },
    };
  }

  /** UNLOADING → UNLOADED in the caller's transaction (manual button or the final CN). */
  private async unloadInTx(
    tx: Tx,
    caller: Caller | null,
    cur: EntryRow,
    extra: Record<string, unknown>,
    by: string,
  ) {
    const s = await this.repo.shipment(cur.shipmentId, tx);
    if (s?.dockBookingId != null)
      await this.deps.docksService.gateMove(
        tx,
        cur.warehouseId,
        s.dockBookingId,
        'complete',
        caller?.userId ?? cur.createdBy,
      );
    return this.move(
      tx,
      caller,
      cur,
      'UNLOAD',
      {
        unloadedAt: new Date(),
        unloadedBy: caller?.userId ?? null,
        dockOutAt: new Date(),
        ...extra,
      },
      { type: 'UNLOADED', data: { by } },
      {
        action: 'gate.entry_unloaded',
        ...(typeof extra.noReceiptReason === 'string' ? { reason: extra.noReceiptReason } : {}),
      },
    );
  }

  /** Manual "unloading complete": a reason is required when no CN is linked (→ noReceipt). */
  async unloaded(caller: Caller, id: string, reason: string | null) {
    const { e } = await this.load(caller, id, 'gate.operate');
    await this.deps.runInTransaction(async (tx) => {
      const cur = await this.repo.lockEntry(tx, id);
      if (cur === null) throw new NotFoundError('Gate entry');
      if (cur.status !== 'UNLOADING') throw stale(cur.status);
      const linked = (await this.repo.receiptsOf(id, tx)).length;
      if (linked === 0 && (reason ?? '').trim().length < 5)
        throw new ValidationError([
          {
            path: 'body.reason',
            message: 'no goods receipt (CN) is linked; give the reason (≥ 5 characters)',
          },
        ]);
      await this.unloadInTx(
        tx,
        caller,
        cur,
        linked === 0 ? { noReceipt: true, noReceiptReason: reason } : {},
        'MANUAL',
      );
    });
    await this.support.bump(e.warehouseId);
    return this.handoverView(id);
  }

  /**
   * Called by the stock receipt (CN) command in ITS transaction (§3 CN link rule): the receipt
   * always posts; a link is made only while the truck is between UNLOADING and PASS_OUT (else a
   * warning); `finalForGate` moves UNLOADING → UNLOADED (no-op otherwise); a link clears
   * `noReceipt`.
   */
  async linkReceiptInTx(
    tx: Tx,
    caller: Caller,
    r: {
      gateEntryId: string;
      receiptId: string;
      cnNo: string;
      warehouseId: string;
      vendorId: string | null;
      finalForGate: boolean;
    },
  ): Promise<{ linked: boolean; warning: { code: string; reason: string } | null }> {
    const cur = await this.repo.lockEntry(tx, r.gateEntryId);
    if (cur?.warehouseId !== r.warehouseId)
      return {
        linked: false,
        warning: { code: 'GATE_LINK_SKIPPED', reason: 'GATE_ENTRY_NOT_FOUND' },
      };
    if (
      !canLinkReceipt({
        status: cur.status,
        pausedFromStatus: cur.pausedFromStatus,
      })
    )
      return {
        linked: false,
        warning: { code: 'GATE_LINK_SKIPPED', reason: `ENTRY_${cur.status}` },
      };
    await this.repo.linkReceipt(tx, {
      gateEntryId: cur.id,
      receiptId: r.receiptId,
      cnNo: r.cnNo,
      finalForGate: r.finalForGate,
      attachedBy: caller.userId,
    });
    await this.support.event(tx, {
      warehouseId: cur.warehouseId,
      shipmentId: cur.shipmentId,
      gateEntryId: cur.id,
      type: 'CN_LINKED',
      byUserId: caller.userId,
      data: { cnNo: r.cnNo, finalForGate: r.finalForGate },
    });
    let entry = cur;
    if (cur.noReceipt) {
      const cleared = await this.repo.guardedUpdate(tx, cur.id, null, { noReceipt: false });
      if (cleared !== null) {
        entry = cleared;
        await this.support.syncEntry(tx, cleared, cur.status);
      }
    }
    if (r.finalForGate && entry.status === 'UNLOADING')
      await this.unloadInTx(tx, caller, entry, {}, 'CN');
    return { linked: true, warning: null };
  }

  async receipts(caller: Caller, id: string) {
    await this.load(caller, id);
    const rows = await this.repo.receiptsOf(id);
    return rows.map((r) => ({
      receiptId: r.receiptId,
      cnNo: r.cnNo,
      finalForGate: r.finalForGate,
      attachedAt: r.attachedAt.toISOString(),
      attachedBy: r.attachedBy,
    }));
  }

  /** Header search hits (portal): inbound shipments, gate entries / vehicles, gate passes. */
  async search(caller: Caller, q: string) {
    if (q.length < 3 || !caller.access.holdsAnywhere('gate.view')) return [];
    const r = await this.repo.search(caller.access.scope('gate.view'), q, 5);
    return [
      ...r.shipments.map((s) => ({
        type: 'gate_shipment' as const,
        id: s.id,
        title: `Inbound ${s.shipmentNo}`,
        subtitle: [
          s.vendorName,
          s.vehicleRegNo === null ? null : formatRegNo(s.vehicleRegNo),
          s.stage,
        ]
          .filter((x) => x !== null)
          .join(' · '),
        warehouseId: s.warehouseId,
      })),
      ...r.entries.map((e) => ({
        type: 'gate_entry' as const,
        id: e.id,
        title: `Vehicle ${formatRegNo(e.vehicleRegNo)}`,
        subtitle: `${e.entryNo} · ${e.status}`,
        warehouseId: e.warehouseId,
      })),
      ...r.passes.map((p) => ({
        type: 'gate_pass' as const,
        id: p.gateEntryId,
        title: `Gate pass ${p.passNo}`,
        subtitle: p.status,
        warehouseId: p.warehouseId,
      })),
    ];
  }

  // ── W5.08 timeline ──

  async timeline(caller: Caller, id: string) {
    const { e } = await this.load(caller, id);
    const events = await this.repo.eventsOf(e.shipmentId);
    const items = events.map(eventView);
    return {
      shipmentId: e.shipmentId,
      entryId: e.id,
      completed: items.filter((x) => x.type !== 'SHIPMENT_CREATED').length,
      items,
    };
  }
}
