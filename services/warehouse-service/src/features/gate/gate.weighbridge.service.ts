import { ForbiddenError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { Caller } from '../../middleware/guards.js';
import { num } from '../../middleware/http.js';
import type { WarehouseRecord } from '../warehouses/index.js';
import type { EntryRow, ScaleRow, ShipmentRow, WeighmentRow } from './gate.repository.js';
import {
  type EntryStatus,
  type GateSettings,
  type Reconciliation,
  exitCheck,
  expectedLoad,
  formatRegNo,
  normalizeRegNo,
  reconcile,
  redeliveryDoc,
} from './gate.rules.js';
import { conflict, stale } from './gate.support.js';
import { tonnes, weighmentView } from './gate.views.js';

export interface WeighInput {
  kind: 'GROSS' | 'TARE' | 'EXIT_CHECK';
  weightKg: number;
  scaleId?: string | null;
  slipNo?: string | null;
  slipReceipt?: string | null;
}

const ymd = (d: Date | null) => (d === null ? null : d.toISOString().slice(0, 10));
const sameUser = () =>
  new ForbiddenError('The person who captured the weight cannot approve it', {
    details: { reason: 'SAME_USER' },
  });

/**
 * Weighbridge (W5.09 / W5.10, D-62): manual weighments (gross at arrival, tare after unloading,
 * exit check for a turned-away truck), reconciliation against the expected load, holds and their
 * resolution (accept / reweigh / debit note), manual overrides with maker ≠ checker review, the
 * outward pass and the exit. A pending override or an open security hold blocks pass-out and exit.
 */
export class GateWeighbridgeService {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'gateRepository'
      | 'gateRegistersRepository'
      | 'gateSupport'
      | 'gateEntries'
      | 'gatePasses'
      | 'docksService'
      | 'mediaClient'
      | 'runInTransaction'
    >,
  ) {}

  private get repo() {
    return this.deps.gateRepository;
  }
  private get support() {
    return this.deps.gateSupport;
  }

  // ── scales ──

  async scales(caller: Caller, warehouseId: string) {
    const w = await this.support.warehouse(caller, warehouseId, 'gate.view');
    const today = this.support.today(w).date;
    const rows = await this.repo.scales(w.id);
    return rows.map((s) => this.scaleView(s, today));
  }

  scaleView(s: ScaleRow, today: string) {
    const valid = (ymd(s.calibrationValidUntil) ?? '9999-12-31') >= today;
    return {
      id: s.id,
      code: s.code,
      name: s.name,
      maxCapacityKg: num(s.maxCapacityKg),
      divisionKg: num(s.divisionKg),
      captureMethod: s.captureMethod,
      captureMethodLabel: s.captureMethod === 'MANUAL' ? 'Manual' : 'Automatic',
      calibratedAt: ymd(s.calibratedAt),
      calibrationValidUntil: ymd(s.calibrationValidUntil),
      calibration: valid ? 'VALID' : 'EXPIRED',
      status: s.status,
      /** Live device feed is Future: a manual scale has no online/offline state. */
      connection: s.captureMethod === 'MANUAL' ? 'NOT_AVAILABLE' : 'UNKNOWN',
      lastWeighedAt: s.lastWeighedAt?.toISOString() ?? null,
      version: s.version,
    };
  }

  /** Scale check: active, calibration in date, weight within capacity. */
  private async scaleFor(
    tx: Tx,
    warehouseId: string,
    scaleId: string | null,
    weightKg: number,
    today: string,
  ) {
    if (scaleId === null) {
      const any = (await this.repo.scales(warehouseId, tx)).filter((s) => s.status === 'ACTIVE');
      if (any.length > 0)
        throw new ValidationError([
          { path: 'body.scaleId', message: 'pick the weighbridge scale used' },
        ]);
      return null;
    }
    const s = await this.repo.scale(scaleId, tx);
    if (s?.warehouseId !== warehouseId)
      throw new ValidationError([
        { path: 'body.scaleId', message: 'is not a scale of this warehouse' },
      ]);
    if (s.status !== 'ACTIVE') throw conflict('SCALE_INACTIVE', `Scale ${s.code} is not active`);
    if ((ymd(s.calibrationValidUntil) ?? '9999-12-31') < today)
      throw conflict(
        'CALIBRATION_EXPIRED',
        `Scale ${s.code} calibration expired on ${ymd(s.calibrationValidUntil) ?? ''}`,
      );
    if (weightKg > num(s.maxCapacityKg))
      throw new ValidationError([
        {
          path: 'body.weightKg',
          message: `exceeds the scale capacity (${String(num(s.maxCapacityKg))} kg)`,
        },
      ]);
    return s;
  }

  // ── reconciliation ──

  private async expectedFor(s: ShipmentRow, settings: GateSettings) {
    return expectedLoad({
      invoiceGrossKg: s.invoiceGrossKg === null ? null : num(s.invoiceGrossKg),
      declaredNetKg: s.declaredNetKg === null ? null : num(s.declaredNetKg),
      palletCount: s.palletCount,
      allowance: settings['gate.packagingAllowance'][s.purpose],
    });
  }

  private reconData(r: Reconciliation) {
    return {
      netKg: r.measuredNetKg,
      expectedLoadKg: r.expectedLoadKg,
      packagingAllowanceKg: r.packagingAllowanceKg,
      varianceKg: r.varianceKg,
      toleranceKg: r.toleranceKg,
      reconBasis: r.basis,
      reconResult: r.result,
    };
  }

  /**
   * Captures one reading inside the caller's transaction (entry already locked). GROSS: ARRIVED →
   * WEIGHED_IN. TARE: UNLOADED → WEIGHED_OUT or HELD (breach / no declared weight). EXIT_CHECK:
   * REJECTED truck vs its gross; a mismatch opens an AUTO security HOLD.
   */
  async captureInTx(
    tx: Tx,
    caller: Caller,
    cur: EntryRow,
    w: WarehouseRecord,
    settings: GateSettings,
    input: WeighInput,
  ): Promise<EntryRow> {
    const today = this.support.today(w).date;
    const scale = await this.scaleFor(tx, w.id, input.scaleId ?? null, input.weightKg, today);
    const slip =
      input.slipReceipt === undefined || input.slipReceipt === null
        ? null
        : this.deps.mediaClient.verify(
            input.slipReceipt,
            caller.userId,
            'body.slipReceipt',
            'gate_document',
          );
    const now = new Date();
    const record = () =>
      this.repo.createWeighment(tx, {
        gateEntryId: cur.id,
        warehouseId: cur.warehouseId,
        kind: input.kind,
        scaleId: scale?.id ?? null,
        weightKg: input.weightKg,
        method: 'MANUAL',
        slipNo: input.slipNo ?? null,
        slipMediaKey: slip?.key ?? null,
        capturedBy: caller.userId,
        capturedAt: now,
      });
    if (scale !== null) await this.repo.touchScale(tx, scale.id, now);
    const entries = this.deps.gateEntries;
    if (input.kind === 'GROSS') {
      if (cur.status !== 'ARRIVED') throw stale(cur.status);
      const w1 = await record();
      return entries.move(
        tx,
        caller,
        cur,
        'GROSS',
        { grossKg: input.weightKg, grossAt: now },
        {
          type: 'GROSS_CAPTURED',
          data: { weighmentId: w1.id, weightKg: input.weightKg, scale: scale?.code ?? null },
        },
        { action: 'gate.gross_captured', after: { grossKg: input.weightKg } },
      );
    }
    if (input.kind === 'TARE') {
      if (cur.status !== 'UNLOADED') throw stale(cur.status);
      if (cur.grossKg === null) throw conflict('GROSS_REQUIRED', 'No gross weight was captured');
      if (input.weightKg >= num(cur.grossKg))
        throw new ValidationError([
          { path: 'body.weightKg', message: 'tare must be below the gross weight' },
        ]);
      const w1 = await record();
      const s = await this.repo.shipment(cur.shipmentId, tx);
      if (s === null) throw new NotFoundError('Inbound shipment');
      const r = reconcile({
        grossKg: num(cur.grossKg),
        tareKg: input.weightKg,
        expected: await this.expectedFor(s, settings),
        tolerance: settings['gate.weightTolerance'],
      });
      const within = r.result === 'WITHIN';
      return entries.move(
        tx,
        caller,
        cur,
        within ? 'TARE_WITHIN' : 'TARE_HOLD',
        {
          tareKg: input.weightKg,
          tareAt: now,
          ...this.reconData(r),
          ...(within
            ? {}
            : {
                holdReason: r.result === 'BREACH' ? 'BREACH' : 'NO_DECLARED_WEIGHT',
                holdNote: null,
                heldAt: now,
                heldBy: caller.userId,
                holdResolution: null,
                holdResolvedAt: null,
                holdResolvedBy: null,
              }),
        },
        {
          type: within ? 'TARE_CAPTURED' : 'HELD',
          data: {
            weighmentId: w1.id,
            weightKg: input.weightKg,
            result: r.result,
            varianceKg: r.varianceKg,
          },
        },
        {
          action: within ? 'gate.tare_captured' : 'gate.weight_held',
          after: { tareKg: input.weightKg, result: r.result },
        },
      );
    }
    // EXIT_CHECK: turned-away truck leaves loaded.
    if (cur.status !== 'REJECTED') throw stale(cur.status);
    if (cur.grossKg === null) {
      await record();
      const done = await this.repo.guardedUpdate(tx, cur.id, ['REJECTED'], {
        exitCheckKg: input.weightKg,
        exitCheckResult: 'WITHIN',
      });
      if (done === null) throw stale(cur.status);
      return done;
    }
    const existing = (await this.repo.weighmentsOf(cur.id, tx)).find(
      (x) => x.kind === 'EXIT_CHECK' && x.status === 'ACTIVE',
    );
    if (existing !== undefined)
      await this.repo.updateWeighmentIf(tx, existing.id, 'ACTIVE', { status: 'SUPERSEDED' });
    const w1 = await record();
    const c = exitCheck(num(cur.grossKg), input.weightKg, settings['gate.weightTolerance']);
    const done = await this.repo.guardedUpdate(tx, cur.id, ['REJECTED'], {
      exitCheckKg: input.weightKg,
      exitCheckResult: c.result,
    });
    if (done === null) throw stale(cur.status);
    await this.support.event(tx, {
      warehouseId: cur.warehouseId,
      shipmentId: cur.shipmentId,
      gateEntryId: cur.id,
      type: 'EXIT_CHECK',
      byUserId: caller.userId,
      data: {
        weighmentId: w1.id,
        weightKg: input.weightKg,
        result: c.result,
        differenceKg: c.differenceKg,
      },
    });
    if (c.result === 'MISMATCH') {
      const check = await this.deps.gateRegistersRepository.createCheck(tx, {
        warehouseId: cur.warehouseId,
        subjectType: 'ENTRY',
        subjectId: cur.id,
        subjectRef: cur.entryNo,
        source: 'AUTO',
        reason: 'EXIT_WEIGHT_MISMATCH',
        remarks: `Exit weight ${String(input.weightKg)} kg differs from gross ${String(num(cur.grossKg))} kg by ${String(c.differenceKg)} kg (allowed ${String(c.allowedKg)} kg)`,
        result: 'HOLD',
        createdBy: caller.userId,
      });
      await this.support.event(tx, {
        warehouseId: cur.warehouseId,
        shipmentId: cur.shipmentId,
        gateEntryId: cur.id,
        type: 'SECURITY_HOLD',
        byUserId: caller.userId,
        data: { checkId: check.id, reason: 'EXIT_WEIGHT_MISMATCH' },
      });
    }
    await this.support.audit(tx, caller, 'gate.exit_check', 'gate_entry', cur.id, {
      exitCheckKg: input.weightKg,
      result: c.result,
    });
    return done;
  }

  async capture(caller: Caller, entryId: string, input: WeighInput) {
    const { e, w } = await this.deps.gateEntries.load(caller, entryId, 'gate.operate');
    const settings = await this.support.settings(w.id);
    await this.deps.runInTransaction(async (tx) => {
      const cur = await this.repo.lockEntry(tx, entryId);
      if (cur === null) throw new NotFoundError('Gate entry');
      if (await this.repo.hasPendingWeighment(tx, entryId))
        throw conflict('OVERRIDE_PENDING', 'A manual weighment is waiting for review');
      await this.captureInTx(tx, caller, cur, w, settings, input);
    });
    await this.support.bump(e.warehouseId);
    return this.weighments(caller, entryId);
  }

  /** W5.09 "Start weighment": the vehicle's active entry and the reading it needs next. */
  async lookup(caller: Caller, warehouseId: string, regNo: string) {
    const w = await this.support.warehouse(caller, warehouseId, 'gate.view');
    const reg = normalizeRegNo(regNo);
    const e = await this.repo.activeEntryForVehicle(w.id, reg);
    if (e === null)
      return {
        found: false as const,
        vehicleRegNo: reg,
        vehicleDisplay: formatRegNo(reg),
        entry: null,
        nextPhase: null,
      };
    const settings = await this.support.settings(w.id);
    const next =
      e.status === 'ARRIVED'
        ? 'GROSS'
        : e.status === 'UNLOADED'
          ? 'TARE'
          : e.status === 'REJECTED' &&
              settings['gate.exitCheckOnReject'] &&
              e.exitCheckResult !== 'WITHIN'
            ? 'EXIT_CHECK'
            : null;
    return {
      found: true as const,
      vehicleRegNo: reg,
      vehicleDisplay: formatRegNo(reg),
      entry: await this.deps.gateEntries.out(e.id),
      nextPhase: next,
      reason:
        next === null
          ? `Nothing to weigh while ${e.status.toLowerCase().replaceAll('_', ' ')}`
          : null,
    };
  }

  async weighments(caller: Caller, entryId: string) {
    const { e, w } = await this.deps.gateEntries.load(caller, entryId);
    const [rows, scales] = await Promise.all([
      this.repo.weighmentsOf(entryId),
      this.repo.scales(w.id),
    ]);
    const code = new Map(scales.map((s) => [s.id, s.code]));
    const view = (x: WeighmentRow) =>
      weighmentView(x, x.scaleId === null ? null : (code.get(x.scaleId) ?? null));
    const active = (k: string) => rows.find((x) => x.kind === k && x.status === 'ACTIVE');
    const gross = active('GROSS');
    const tare = active('TARE');
    const exitReading = active('EXIT_CHECK');
    const today = this.support.today(w).date;
    const scale = scales.find((s) => s.id === (gross ?? tare)?.scaleId) ?? scales[0] ?? null;
    return {
      entryId,
      entryNo: e.entryNo,
      vehicleDisplay: formatRegNo(e.vehicleRegNo),
      driver: { name: e.driverName, verified: e.driverVerified },
      kpis: {
        liveScale: scale === null ? null : this.scaleView(scale, today),
        grossKg: e.grossKg === null ? null : num(e.grossKg),
        tareKg: e.tareKg === null ? null : num(e.tareKg),
        netCargoKg: e.netKg === null ? null : num(e.netKg),
      },
      gross: gross === undefined ? null : view(gross),
      tare: tare === undefined ? null : view(tare),
      exitCheck: exitReading === undefined ? null : view(exitReading),
      pending: rows.filter((x) => x.status === 'PENDING_APPROVAL').map(view),
      history: rows.map(view),
      details: {
        status: e.tareKg === null ? 'PENDING' : 'COMPLETED',
        netCargoKg: e.netKg === null ? null : num(e.netKg),
        netCargoMt: tonnes(e.netKg === null ? null : num(e.netKg)),
        at: e.tareAt?.toISOString() ?? null,
        plateCamera: { status: 'NOT_AVAILABLE' as const },
      },
    };
  }

  /** W5.09b / W5.10 tolerance card (live, also before the tare). */
  async reconciliation(caller: Caller, entryId: string) {
    const { e, w } = await this.deps.gateEntries.load(caller, entryId);
    const [s, settings] = await Promise.all([
      this.repo.shipment(e.shipmentId),
      this.support.settings(w.id),
    ]);
    if (s === null) throw new NotFoundError('Inbound shipment');
    const expected = await this.expectedFor(s, settings);
    const r =
      e.grossKg === null || e.tareKg === null
        ? null
        : reconcile({
            grossKg: num(e.grossKg),
            tareKg: num(e.tareKg),
            expected,
            tolerance: settings['gate.weightTolerance'],
          });
    return {
      entryId,
      grossKg: e.grossKg === null ? null : num(e.grossKg),
      tareKg: e.tareKg === null ? null : num(e.tareKg),
      measuredNetKg: r?.measuredNetKg ?? null,
      declaredNetKg:
        expected?.declaredNetKg ?? (s.declaredNetKg === null ? null : num(s.declaredNetKg)),
      invoiceNetKg: s.invoiceNetKg === null ? null : num(s.invoiceNetKg),
      invoiceGrossKg: s.invoiceGrossKg === null ? null : num(s.invoiceGrossKg),
      packagingAllowanceKg: expected?.packagingAllowanceKg ?? null,
      expectedLoadKg: expected?.expectedLoadKg ?? null,
      basis: expected?.basis ?? null,
      varianceKg: r?.varianceKg ?? null,
      toleranceKg: r?.toleranceKg ?? null,
      tolerance: settings['gate.weightTolerance'],
      result: r?.result ?? (expected === null ? 'NO_DECLARED_WEIGHT' : null),
      resultLabel:
        r === null
          ? 'Waiting for tare'
          : r.result === 'WITHIN'
            ? `${String(r.varianceKg)} kg · Within tolerance`
            : r.result === 'BREACH'
              ? `${String(r.varianceKg)} kg · Tolerance breach`
              : 'No declared weight · supervisor review',
      status: e.status,
      exitCheck: {
        kg: e.exitCheckKg === null ? null : num(e.exitCheckKg),
        result: e.exitCheckResult,
      },
    };
  }

  // ── holds ──

  async hold(caller: Caller, entryId: string, note: string) {
    const { e } = await this.deps.gateEntries.load(caller, entryId, 'gate.operate');
    await this.deps.runInTransaction(async (tx) => {
      const cur = await this.repo.lockEntry(tx, entryId);
      if (cur === null) throw new NotFoundError('Gate entry');
      await this.deps.gateEntries.move(
        tx,
        caller,
        cur,
        'HOLD',
        {
          holdReason: 'MANUAL',
          holdNote: note,
          heldAt: new Date(),
          heldBy: caller.userId,
          holdResolution: null,
          holdResolvedAt: null,
          holdResolvedBy: null,
        },
        { type: 'HELD', data: { reason: 'MANUAL' } },
        { action: 'gate.weight_held', reason: note },
      );
    });
    await this.support.bump(e.warehouseId);
    return this.deps.gateEntries.out(entryId);
  }

  /** Supersede the ACTIVE reading of a kind and record the new one (REWEIGH / approved override). */
  private async replaceReading(
    tx: Tx,
    cur: EntryRow,
    kind: 'GROSS' | 'TARE',
    weightKg: number,
  ): Promise<{ grossKg: number; tareKg: number | null }> {
    const grossKg = kind === 'GROSS' ? weightKg : num(cur.grossKg);
    const tareKg = kind === 'TARE' ? weightKg : cur.tareKg === null ? null : num(cur.tareKg);
    if (tareKg !== null && tareKg >= grossKg)
      throw new ValidationError([
        { path: 'body.weightKg', message: 'tare must stay below the gross weight' },
      ]);
    return { grossKg, tareKg };
  }

  async resolveHold(
    caller: Caller,
    entryId: string,
    input: {
      resolution: 'ACCEPT_VARIANCE' | 'REWEIGH' | 'ACCEPT_WITH_DEBIT_NOTE';
      note: string;
      reweigh?: {
        kind: 'GROSS' | 'TARE';
        weightKg: number;
        scaleId?: string | null;
        slipNo?: string | null;
      } | null;
    },
  ) {
    const { e, w } = await this.deps.gateEntries.load(caller, entryId, 'gate.approve');
    const settings = await this.support.settings(w.id);
    await this.deps.runInTransaction(async (tx) => {
      const cur = await this.repo.lockEntry(tx, entryId);
      if (cur === null) throw new NotFoundError('Gate entry');
      if (cur.status !== 'HELD') throw stale(cur.status);
      // Maker = who captured the tare (or who held it manually).
      const tare = (await this.repo.weighmentsOf(entryId, tx)).find(
        (x) => x.kind === 'TARE' && x.status === 'ACTIVE',
      );
      const maker = cur.holdReason === 'MANUAL' ? cur.heldBy : (tare?.capturedBy ?? null);
      if (input.resolution !== 'REWEIGH' && maker === caller.userId) throw sameUser();
      const entries = this.deps.gateEntries;
      if (input.resolution !== 'REWEIGH') {
        await entries.move(
          tx,
          caller,
          cur,
          'RESOLVE_ACCEPT',
          {
            holdResolution: input.resolution,
            holdResolvedAt: new Date(),
            holdResolvedBy: caller.userId,
            ...(input.resolution === 'ACCEPT_WITH_DEBIT_NOTE' ? { debitNoteRequired: true } : {}),
          },
          {
            type: 'HOLD_RESOLVED',
            data: {
              resolution: input.resolution,
              varianceKg: cur.varianceKg === null ? null : num(cur.varianceKg),
            },
          },
          {
            action: 'gate.hold_resolved',
            reason: input.note,
            after: { resolution: input.resolution },
          },
        );
        return;
      }
      if (input.reweigh === undefined || input.reweigh === null)
        throw new ValidationError([{ path: 'body.reweigh', message: 'is required to re-weigh' }]);
      const rw = input.reweigh;
      const today = this.support.today(w).date;
      const scale = await this.scaleFor(tx, w.id, rw.scaleId ?? null, rw.weightKg, today);
      const { grossKg, tareKg } = await this.replaceReading(tx, cur, rw.kind, rw.weightKg);
      const old = (await this.repo.weighmentsOf(entryId, tx)).find(
        (x) => x.kind === rw.kind && x.status === 'ACTIVE',
      );
      if (old !== undefined)
        await this.repo.updateWeighmentIf(tx, old.id, 'ACTIVE', { status: 'SUPERSEDED' });
      const nw = await this.repo.createWeighment(tx, {
        gateEntryId: cur.id,
        warehouseId: cur.warehouseId,
        kind: rw.kind,
        scaleId: scale?.id ?? null,
        weightKg: rw.weightKg,
        method: 'REWEIGH',
        slipNo: rw.slipNo ?? null,
        status: 'ACTIVE',
        reason: input.note,
        capturedBy: caller.userId,
        supersedesId: old?.id ?? null,
      });
      const s = await this.repo.shipment(cur.shipmentId, tx);
      if (s === null) throw new NotFoundError('Inbound shipment');
      const r = reconcile({
        grossKg,
        tareKg: tareKg ?? 0,
        expected: await this.expectedFor(s, settings),
        tolerance: settings['gate.weightTolerance'],
      });
      const data = {
        grossKg,
        tareKg,
        ...this.reconData(r),
        ...(rw.kind === 'TARE' ? { tareAt: new Date() } : { grossAt: new Date() }),
      };
      if (r.result === 'WITHIN') {
        await entries.move(
          tx,
          caller,
          cur,
          'RESOLVE_ACCEPT',
          {
            ...data,
            holdResolution: 'REWEIGH',
            holdResolvedAt: new Date(),
            holdResolvedBy: caller.userId,
          },
          {
            type: 'HOLD_RESOLVED',
            data: { resolution: 'REWEIGH', weighmentId: nw.id, result: r.result },
          },
          {
            action: 'gate.hold_resolved',
            reason: input.note,
            after: { resolution: 'REWEIGH', result: r.result },
          },
        );
      } else {
        const still = await this.repo.guardedUpdate(tx, cur.id, ['HELD'], {
          ...data,
          holdReason: r.result === 'BREACH' ? 'BREACH' : 'NO_DECLARED_WEIGHT',
          heldAt: new Date(),
        });
        if (still === null) throw stale(cur.status);
        await this.support.syncEntry(tx, still, 'HELD');
        await this.support.event(tx, {
          warehouseId: cur.warehouseId,
          shipmentId: cur.shipmentId,
          gateEntryId: cur.id,
          type: 'HELD',
          byUserId: caller.userId,
          data: { reweigh: true, weighmentId: nw.id, result: r.result, varianceKg: r.varianceKg },
        });
        await this.support.audit(
          tx,
          caller,
          'gate.reweighed',
          'gate_entry',
          cur.id,
          { result: r.result, kind: rw.kind, weightKg: rw.weightKg },
          null,
          input.note,
        );
      }
    });
    await this.support.bump(e.warehouseId);
    return this.deps.gateEntries.out(entryId);
  }

  // ── manual override (maker-checker) ──

  async override(
    caller: Caller,
    weighmentId: string,
    input: { weightKg: number; reason: string; scaleId?: string | null },
  ) {
    const target = await this.repo.weighment(weighmentId);
    if (target === null) throw new NotFoundError('Weighment');
    const { w } = await this.deps.gateEntries.load(caller, target.gateEntryId, 'gate.operate');
    const pending = await this.deps.runInTransaction(async (tx) => {
      const cur = await this.repo.lockEntry(tx, target.gateEntryId);
      if (cur === null) throw new NotFoundError('Gate entry');
      if (cur.status === 'EXITED' || cur.status === 'CANCELLED')
        throw conflict('ENTRY_CLOSED', 'The vehicle has left; weighments are closed');
      const t = await this.repo.lockWeighment(tx, weighmentId);
      if (t?.status !== 'ACTIVE')
        throw conflict('STALE_STATE', 'Only the active reading can be overridden');
      if (t.kind === 'EXIT_CHECK')
        throw conflict('STALE_STATE', 'Re-capture the exit check instead');
      const today = this.support.today(w).date;
      const scale = await this.scaleFor(
        tx,
        w.id,
        input.scaleId ?? t.scaleId,
        input.weightKg,
        today,
      );
      await this.replaceReading(tx, cur, t.kind, input.weightKg);
      if (await this.repo.hasPendingWeighment(tx, cur.id))
        throw conflict('OVERRIDE_PENDING', 'Another manual weighment is waiting for review');
      const p = await this.repo.createWeighment(tx, {
        gateEntryId: cur.id,
        warehouseId: cur.warehouseId,
        kind: t.kind,
        scaleId: scale?.id ?? null,
        weightKg: input.weightKg,
        method: 'OVERRIDE',
        status: 'PENDING_APPROVAL',
        reason: input.reason,
        capturedBy: caller.userId,
        supersedesId: t.id,
      });
      await this.support.event(tx, {
        warehouseId: cur.warehouseId,
        shipmentId: cur.shipmentId,
        gateEntryId: cur.id,
        type: 'OVERRIDE_REQUESTED',
        byUserId: caller.userId,
        data: { weighmentId: p.id, kind: t.kind, weightKg: input.weightKg },
      });
      await this.support.audit(
        tx,
        caller,
        'gate.override_requested',
        'weighment',
        p.id,
        { kind: t.kind, weightKg: input.weightKg, replaces: t.id },
        null,
        input.reason,
      );
      return p;
    });
    await this.support.bump(w.id);
    return weighmentView(pending, null);
  }

  async review(
    caller: Caller,
    weighmentId: string,
    input: { decision: 'APPROVE' | 'REJECT'; note?: string | null },
  ) {
    const target = await this.repo.weighment(weighmentId);
    if (target === null) throw new NotFoundError('Weighment');
    const { w } = await this.deps.gateEntries.load(caller, target.gateEntryId, 'gate.approve');
    const settings = await this.support.settings(w.id);
    await this.deps.runInTransaction(async (tx) => {
      // Lock order: entry → weighment (same as override / capture).
      const cur = await this.repo.lockEntry(tx, target.gateEntryId);
      if (cur === null) throw new NotFoundError('Gate entry');
      const p = await this.repo.lockWeighment(tx, weighmentId);
      if (p?.status !== 'PENDING_APPROVAL') throw conflict('STALE_STATE', 'Nothing to review');
      if (p.capturedBy === caller.userId) throw sameUser();
      if (input.decision === 'REJECT') {
        await this.repo.updateWeighmentIf(tx, p.id, 'PENDING_APPROVAL', {
          status: 'REJECTED',
          reviewedBy: caller.userId,
          reviewedAt: new Date(),
          reviewNote: input.note ?? null,
        });
        await this.support.event(tx, {
          warehouseId: cur.warehouseId,
          shipmentId: cur.shipmentId,
          gateEntryId: cur.id,
          type: 'OVERRIDE_REJECTED',
          byUserId: caller.userId,
          data: { weighmentId: p.id },
        });
        await this.support.audit(
          tx,
          caller,
          'gate.override_rejected',
          'weighment',
          p.id,
          { status: 'REJECTED' },
          null,
          input.note ?? null,
        );
        return;
      }
      if (cur.status === 'EXITED' || cur.status === 'CANCELLED')
        throw conflict('ENTRY_CLOSED', 'The vehicle has left; weighments are closed');
      const kind = p.kind as 'GROSS' | 'TARE';
      const { grossKg, tareKg } = await this.replaceReading(tx, cur, kind, num(p.weightKg));
      if (p.supersedesId !== null)
        await this.repo.updateWeighmentIf(tx, p.supersedesId, 'ACTIVE', { status: 'SUPERSEDED' });
      await this.repo.updateWeighmentIf(tx, p.id, 'PENDING_APPROVAL', {
        status: 'ACTIVE',
        reviewedBy: caller.userId,
        reviewedAt: new Date(),
        reviewNote: input.note ?? null,
      });
      const data: Record<string, unknown> = { grossKg, tareKg };
      let next: EntryRow | null;
      if (tareKg !== null) {
        const s = await this.repo.shipment(cur.shipmentId, tx);
        if (s === null) throw new NotFoundError('Inbound shipment');
        const r = reconcile({
          grossKg,
          tareKg,
          expected: await this.expectedFor(s, settings),
          tolerance: settings['gate.weightTolerance'],
        });
        Object.assign(data, this.reconData(r));
        const status = cur.status as EntryStatus;
        if (r.result !== 'WITHIN' && (status === 'WEIGHED_OUT' || status === 'PASS_OUT')) {
          // The net changed after the fact: void a live outward pass and hold for review.
          await this.deps.gatePasses.voidLiveInTx(
            tx,
            caller,
            cur,
            'OUTWARD',
            'Weight override changed the net',
          );
          next = await this.repo.guardedUpdate(tx, cur.id, [status], {
            ...data,
            status: 'HELD',
            pausedFromStatus: 'WEIGHED_OUT',
            holdReason: r.result === 'BREACH' ? 'BREACH' : 'NO_DECLARED_WEIGHT',
            heldAt: new Date(),
            heldBy: caller.userId,
            holdResolution: null,
            holdResolvedAt: null,
            holdResolvedBy: null,
          });
        } else if (r.result === 'WITHIN' && status === 'HELD') {
          next = await this.repo.guardedUpdate(tx, cur.id, ['HELD'], {
            ...data,
            status: 'WEIGHED_OUT',
            pausedFromStatus: null,
            holdResolution: 'REWEIGH',
            holdResolvedAt: new Date(),
            holdResolvedBy: caller.userId,
          });
        } else next = await this.repo.guardedUpdate(tx, cur.id, null, data);
      } else next = await this.repo.guardedUpdate(tx, cur.id, null, data);
      if (next === null) throw stale(cur.status);
      await this.support.syncEntry(tx, next, cur.status);
      await this.support.event(tx, {
        warehouseId: cur.warehouseId,
        shipmentId: cur.shipmentId,
        gateEntryId: cur.id,
        type: 'OVERRIDE_APPROVED',
        byUserId: caller.userId,
        data: { weighmentId: p.id, kind, weightKg: num(p.weightKg) },
      });
      await this.support.audit(
        tx,
        caller,
        'gate.override_approved',
        'weighment',
        p.id,
        { status: 'ACTIVE', kind, weightKg: num(p.weightKg) },
        null,
        input.note ?? null,
      );
    });
    await this.support.bump(w.id);
    return this.weighments(caller, target.gateEntryId);
  }

  /** Supervisor inbox: pending overrides, held trucks, open security holds. */
  async approvals(caller: Caller, warehouseId: string, limit: number) {
    const w = await this.support.warehouse(caller, warehouseId, 'gate.view');
    const [pending, held, holds] = await Promise.all([
      this.repo.pendingWeighments(w.id, limit),
      this.repo.heldEntries(w.id, limit),
      this.deps.gateRegistersRepository.listChecks({ warehouseId: w.id, open: true }, null, limit),
    ]);
    const entries = new Map(
      (await this.repo.entriesByIds(pending.map((p) => p.gateEntryId))).map((x) => [x.id, x]),
    );
    return {
      overrides: pending.map((p) => ({
        ...weighmentView(p, null),
        entryNo: entries.get(p.gateEntryId)?.entryNo ?? null,
        vehicleDisplay: formatRegNo(entries.get(p.gateEntryId)?.vehicleRegNo ?? ''),
        mine: p.capturedBy === caller.userId,
      })),
      holds: held.map((h) => ({
        entryId: h.id,
        entryNo: h.entryNo,
        vehicleDisplay: formatRegNo(h.vehicleRegNo),
        reason: h.holdReason,
        varianceKg: h.varianceKg === null ? null : num(h.varianceKg),
        toleranceKg: h.toleranceKg === null ? null : num(h.toleranceKg),
        heldAt: h.heldAt?.toISOString() ?? null,
      })),
      securityHolds: holds.slice(0, limit).map((c) => ({
        id: c.id,
        subjectType: c.subjectType,
        subjectRef: c.subjectRef,
        reason: c.reason,
        remarks: c.remarks,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  }

  // ── outward pass + exit ──

  private async assertCanLeave(tx: Tx, cur: EntryRow) {
    if (await this.repo.hasPendingWeighment(tx, cur.id))
      throw conflict('OVERRIDE_PENDING', 'A manual weighment is waiting for review');
    if ((await this.deps.gateRegistersRepository.openHolds(tx, cur.id)).length > 0)
      throw conflict('SECURITY_HOLD', 'A security hold is open for this vehicle');
  }

  async outwardPass(
    caller: Caller,
    entryId: string,
    input: { emptyTruckVerified?: boolean; remarks?: string | null },
  ) {
    const { e, w } = await this.deps.gateEntries.load(caller, entryId, 'gate.operate');
    const settings = await this.support.settings(w.id);
    await this.deps.runInTransaction(async (tx) => {
      const cur = await this.repo.lockEntry(tx, entryId);
      if (cur === null) throw new NotFoundError('Gate entry');
      await this.assertCanLeave(tx, cur);
      const rejected = cur.status === 'REJECTED';
      if (!rejected && input.emptyTruckVerified !== true)
        throw new ValidationError([
          { path: 'body.emptyTruckVerified', message: 'confirm the truck was checked empty' },
        ]);
      if (
        rejected &&
        settings['gate.exitCheckOnReject'] &&
        cur.grossKg !== null &&
        cur.exitCheckResult !== 'WITHIN'
      )
        throw conflict('EXIT_CHECK_REQUIRED', 'Weigh the returning truck before its outward pass');
      const s = await this.repo.shipment(cur.shipmentId, tx);
      if (s === null) throw new NotFoundError('Inbound shipment');
      const moved = await this.deps.gateEntries.move(
        tx,
        caller,
        cur,
        'OUTWARD_PASS',
        { passOutAt: new Date() },
        { type: 'PASS_OUT_ISSUED', data: { outcome: rejected ? 'REJECTED' : 'COMPLETED' } },
        { action: 'gate.outward_pass', reason: input.remarks ?? null },
      );
      await this.deps.gatePasses.issueInTx(tx, caller, moved, s, 'OUTWARD', w, settings, {
        exitClearance: rejected
          ? 'Rejected · loaded truck returned'
          : 'Approved · Empty truck verified',
        remarks: input.remarks ?? null,
      });
    });
    await this.support.bump(e.warehouseId);
    return {
      entry: await this.deps.gateEntries.out(entryId),
      passes: await this.deps.gatePasses.forEntry(entryId),
    };
  }

  /** PASS_OUT → EXITED inside the caller's transaction (button or GP-OUT scan). */
  async exitInTx(tx: Tx, caller: Caller, cur: EntryRow, w: WarehouseRecord): Promise<EntryRow> {
    if (cur.status !== 'PASS_OUT') throw stale(cur.status);
    await this.assertCanLeave(tx, cur);
    await this.deps.gatePasses.useLiveInTx(tx, caller, cur, 'OUTWARD');
    const s = await this.repo.lockShipment(tx, cur.shipmentId);
    if (s === null) throw new NotFoundError('Inbound shipment');
    if (s.dockBookingId !== null)
      await this.deps.docksService.gateMove(
        tx,
        s.warehouseId,
        s.dockBookingId,
        'complete',
        caller.userId,
      );
    const rejected = cur.outcome === 'REJECTED';
    const now = new Date();
    const exited = await this.deps.gateEntries.move(
      tx,
      caller,
      cur,
      'EXIT',
      {
        outcome: cur.outcome ?? 'COMPLETED',
        exitedAt: now,
        exitedBy: caller.userId,
        ...(rejected ? { shipmentActionAppliedAt: now } : {}),
      },
      { type: 'GATE_OUT', data: { outcome: cur.outcome ?? 'COMPLETED' } },
      { action: 'gate.exited' },
    );
    if (rejected && cur.pendingShipmentAction === 'REEXPECT') {
      // Re-delivery: vehicle-bound + expired documents go back to PENDING, the rest carry forward.
      const today = this.support.today(w).date;
      for (const d of await this.repo.documentsOf(s.id, tx)) {
        const next = redeliveryDoc(
          {
            docType: d.docType,
            status: d.status,
            validUntil: ymd(d.validUntil),
          },
          today,
        );
        await this.repo.updateDocument(tx, d.id, {
          status: next.status,
          expired: next.expired,
          carriedForward: next.carriedForward,
          gateEntryId: null,
          ...(next.status === 'PENDING' ? { verifiedAt: null, verifiedBy: null } : {}),
        });
      }
      await this.repo.updateShipment(tx, s.id, {
        dockBookingId: null,
        dockDoorId: null,
        bayCode: null,
      });
    }
    return exited;
  }

  async exit(caller: Caller, entryId: string) {
    const { e, w } = await this.deps.gateEntries.load(caller, entryId, 'gate.operate');
    await this.deps.runInTransaction(async (tx) => {
      const cur = await this.repo.lockEntry(tx, entryId);
      if (cur === null) throw new NotFoundError('Gate entry');
      await this.exitInTx(tx, caller, cur, w);
    });
    await this.support.bump(e.warehouseId);
    const entry = await this.deps.gateEntries.out(entryId);
    const passes = await this.deps.gatePasses.forEntry(entryId);
    return {
      entry,
      exit: {
        outwardPass:
          passes.find((p) => p.type === 'OUTWARD' && p.status !== 'VOID')?.passNo ?? null,
        vehicle: entry.vehicleDisplay,
        finalStatus: entry.outcome === 'REJECTED' ? 'Gate out · Rejected' : 'Gate out · Completed',
        auditRecord: 'Entry / gross / receiving / tare / exit retained',
      },
    };
  }
}
