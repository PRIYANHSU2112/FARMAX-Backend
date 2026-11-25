import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import { emitWarehouseEvent } from '../../adapters/events.js';
import { uuidv7 } from '../../adapters/uuid.js';
import type { Caller } from '../../middleware/guards.js';
import type { StockMove } from '../stock/index.js';
import type { FlowActor } from './fulfilment.flow.js';
import type { JsonInput, ShipmentRow, TaskRow } from './fulfilment.repository.js';
import { type ChecklistItem, istDay } from './fulfilment.rules.js';

const actorOf = (c: Caller): FlowActor => ({
  type: 'STAFF',
  id: c.userId,
  requestId: c.requestId,
  access: c.access,
});

type Checklist = (ChecklistItem & {
  done: boolean;
  doneAt: string | null;
  doneBy: string | null;
})[];

/**
 * Warehouse floor (W3.06 / W3.07): pick-pack tasks with a checklist, pick batches, pick → pack →
 * QC → stage. Every step moves the exact lots (RESERVED → PICKED → PACKED) and the shipment in one
 * transaction; a QC fail sends it back to packing and raises a QUALITY exception.
 */
export class FulfilmentFloor {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'fulfilmentRepository'
      | 'shipmentFlow'
      | 'stockService'
      | 'fulfilmentSettings'
      | 'teamService'
      | 'runInTransaction'
      | 'auditService'
      | 'fulfilmentExceptions'
    >,
  ) {}

  private get repo() {
    return this.deps.fulfilmentRepository;
  }

  // ── W3.06 assign ──

  /** Operators of a warehouse (work area filter) with their open task load. */
  async operators(caller: Caller, warehouseId: string, q: { workArea?: string; q?: string }) {
    caller.access.require('fulfilment.view', warehouseId);
    const [members, load] = await Promise.all([
      this.deps.teamService.list(caller, warehouseId),
      this.repo.openTaskLoad(warehouseId),
    ]);
    const needle = q.q?.toLowerCase();
    return members
      .filter((m) => m.status === 'ACTIVE')
      .filter(
        (m) =>
          q.workArea === undefined ||
          m.workAreas.length === 0 ||
          m.workAreas.includes(q.workArea as never),
      )
      .filter((m) => needle === undefined || (m.fullName ?? '').toLowerCase().includes(needle))
      .map((m) => ({
        userId: m.userId,
        name: m.fullName,
        roleLabel: m.jobTitle ?? m.roles[0]?.roleName ?? null,
        jobTitle: m.jobTitle,
        workAreas: m.workAreas,
        openTasks: load.get(m.userId) ?? 0,
      }))
      .sort((a, b) => a.openTasks - b.openTasks || (a.name ?? '').localeCompare(b.name ?? ''));
  }

  async template(warehouseId?: string) {
    const [pick, qc] = await Promise.all([
      this.deps.fulfilmentSettings.get('fulfilment.checklistTemplate', warehouseId),
      this.deps.fulfilmentSettings.get('fulfilment.qcChecklist', warehouseId),
    ]);
    return { type: 'PICK_PACK', checklist: pick, qcChecklist: qc };
  }

  async assign(
    caller: Caller,
    shipmentId: string,
    input: {
      assigneeUserId: string;
      priority?: 'STANDARD' | 'PRIORITY';
      deadlineAt?: string;
      note?: string | null;
    },
    batchId: string | null = null,
    txIn?: Tx,
  ): Promise<TaskRow> {
    const run = async (tx: Tx) => {
      const s = await this.lock(tx, caller, shipmentId, 'fulfilment.manage');
      if (s.status !== 'ALLOCATED')
        throw new ConflictError(
          s.status === 'ASSIGNED'
            ? 'Already assigned; reassign the task instead'
            : 'Allocate stock (FEFO) first',
          { details: { reason: s.status === 'ASSIGNED' ? 'ALREADY_ASSIGNED' : 'NOT_ALLOCATED' } },
        );
      const tpl = await this.deps.fulfilmentSettings.get(
        'fulfilment.checklistTemplate',
        s.warehouseId,
      );
      const checklist: Checklist = tpl
        .filter((i) => i.key !== 'cold_chain' || s.coldRequired)
        .map((i) => ({ ...i, done: false, doneAt: null, doneBy: null }));
      const task = await this.repo.createTask(tx, {
        taskNo: await this.deps.stockService.nextDocNo(tx, 'TSK'),
        shipmentId: s.id,
        warehouseId: s.warehouseId,
        type: 'PICK_PACK',
        assigneeUserId: input.assigneeUserId,
        priority: input.priority ?? s.priority,
        deadlineAt: input.deadlineAt === undefined ? s.slaDueAt : new Date(input.deadlineAt),
        checklist: checklist as unknown as JsonInput,
        pickBatchId: batchId,
        createdBy: caller.userId,
      });
      await this.deps.shipmentFlow.move(tx, s, 'ASSIGNED', actorOf(caller), 'TASK_ASSIGNED', {
        note: input.note ?? null,
        data: input.priority === undefined ? {} : { priority: input.priority },
      });
      await this.audit(tx, caller, 'fulfilment.task_assigned', task.id, {
        shipmentId: s.id,
        assigneeUserId: input.assigneeUserId,
      });
      return task;
    };
    return txIn === undefined ? this.deps.runInTransaction(run) : run(txIn);
  }

  /** W3.07 "Batch #B-…": one pick batch, one task per allocated shipment. */
  async batch(
    caller: Caller,
    input: {
      shipmentIds: string[];
      assigneeUserId: string;
      priority?: 'STANDARD' | 'PRIORITY';
      deadlineAt?: string;
    },
  ) {
    return this.deps.runInTransaction(async (tx) => {
      const first = await this.repo.shipment(input.shipmentIds[0] ?? '', tx);
      if (first === null) throw new NotFoundError('Shipment');
      caller.access.require('fulfilment.manage', first.warehouseId);
      const b = await this.repo.createPickBatch(tx, {
        batchNo: await this.deps.stockService.nextDocNo(tx, 'B'),
        warehouseId: first.warehouseId,
        createdBy: caller.userId,
      });
      const tasks = [];
      for (const id of new Set(input.shipmentIds)) {
        const s = await this.repo.shipment(id, tx);
        if (s?.warehouseId !== first.warehouseId)
          throw new ValidationError([
            { path: 'body.shipmentIds', message: 'all shipments must be at one warehouse' },
          ]);
        tasks.push(await this.assign(caller, id, input, b.id, tx));
      }
      return {
        batchId: b.id,
        batchNo: b.batchNo,
        tasks: tasks.map((t) => ({ id: t.id, taskNo: t.taskNo, shipmentId: t.shipmentId })),
      };
    });
  }

  async patchTask(
    caller: Caller,
    taskId: string,
    input: {
      assigneeUserId?: string;
      priority?: 'STANDARD' | 'PRIORITY';
      deadlineAt?: string | null;
      status?: 'CANCELLED';
      note?: string | null;
      expectedVersion: number;
    },
  ) {
    return this.deps.runInTransaction(async (tx) => {
      const t = await this.repo.lockTask(tx, taskId);
      if (t === null) throw new NotFoundError('Task');
      caller.access.require('fulfilment.manage', t.warehouseId);
      if (t.version !== input.expectedVersion)
        throw new ConflictError('The task changed', { details: { reason: 'VERSION_CONFLICT' } });
      if (t.status === 'DONE' || t.status === 'CANCELLED')
        throw new ConflictError('The task is closed', { details: { reason: 'INVALID_STATE' } });
      const updated = await this.repo.updateTask(tx, taskId, {
        ...(input.assigneeUserId === undefined ? {} : { assigneeUserId: input.assigneeUserId }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.deadlineAt === undefined
          ? {}
          : { deadlineAt: input.deadlineAt === null ? null : new Date(input.deadlineAt) }),
        ...(input.status === undefined ? {} : { status: input.status }),
      });
      const s = await this.repo.lockShipment(tx, t.shipmentId);
      if (s !== null) {
        if (input.status === 'CANCELLED' && s.status === 'ASSIGNED')
          await this.deps.shipmentFlow.move(tx, s, 'ALLOCATED', actorOf(caller), 'TASK_CANCELLED', {
            note: input.note ?? null,
          });
        else if (input.assigneeUserId !== undefined)
          await this.deps.shipmentFlow.note(
            tx,
            s,
            'TASK_REASSIGNED',
            actorOf(caller),
            input.note ?? null,
          );
        if (input.priority !== undefined)
          await this.repo.updateShipment(tx, s.id, { priority: input.priority });
      }
      await this.audit(tx, caller, 'fulfilment.task_updated', taskId, input, input.note ?? null);
      return this.taskView(updated);
    });
  }

  async tickChecklist(caller: Caller, taskId: string, key: string, done: boolean) {
    return this.deps.runInTransaction(async (tx) => {
      const t = await this.repo.lockTask(tx, taskId);
      if (t === null) throw new NotFoundError('Task');
      caller.access.require('fulfilment.view', t.warehouseId);
      if (
        t.assigneeUserId !== caller.userId &&
        !caller.access.can('fulfilment.manage', t.warehouseId)
      )
        throw new ConflictError('Only the assignee or a supervisor can tick the checklist', {
          details: { reason: 'NOT_ASSIGNEE' },
        });
      const list = t.checklist as unknown as Checklist;
      const item = list.find((i) => i.key === key);
      if (item === undefined) throw new NotFoundError('Checklist item');
      item.done = done;
      item.doneAt = done ? new Date().toISOString() : null;
      item.doneBy = done ? caller.userId : null;
      return this.taskView(
        await this.repo.updateTask(tx, taskId, {
          checklist: list as unknown as JsonInput,
        }),
      );
    });
  }

  async tasks(
    caller: Caller,
    q: {
      assignee?: string;
      status?: string;
      warehouseId?: string;
      pickBatchId?: string;
      cursor?: string;
      limit: number;
    },
  ) {
    if (q.warehouseId !== undefined) caller.access.require('fulfilment.view', q.warehouseId);
    const scope =
      q.warehouseId !== undefined ? [q.warehouseId] : caller.access.scope('fulfilment.view');
    const rows = await this.repo.tasks({
      warehouseIds: scope,
      ...(q.assignee === undefined
        ? {}
        : { assigneeUserId: q.assignee === 'me' ? caller.userId : q.assignee }),
      ...(q.status === undefined ? {} : { status: q.status }),
      ...(q.pickBatchId === undefined ? {} : { pickBatchId: q.pickBatchId }),
      ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
      limit: q.limit,
    });
    const items = rows.slice(0, q.limit);
    const shipments = new Map(
      (await this.repo.shipmentsByIds(items.map((t) => t.shipmentId))).map((s) => [s.id, s]),
    );
    return {
      items: items.map((t) => ({
        ...this.taskView(t),
        shipmentNo: shipments.get(t.shipmentId)?.shipmentNo ?? null,
        shipmentStatus: shipments.get(t.shipmentId)?.status ?? null,
      })),
      nextCursor: rows.length > q.limit ? (items.at(-1)?.id ?? null) : null,
      limit: q.limit,
    };
  }

  async task(caller: Caller, id: string) {
    const t = await this.repo.task(id);
    if (t === null) throw new NotFoundError('Task');
    caller.access.require('fulfilment.view', t.warehouseId);
    return this.taskView(t);
  }

  // ── W3.07 floor steps ──

  /** Picks units of allocations (RESERVED → PICKED). No lines = everything still to pick. */
  async pick(
    caller: Caller,
    shipmentId: string,
    input: { lines?: { allocationId: string; qty: number }[] },
  ) {
    await this.deps.runInTransaction(async (tx) => {
      const s = await this.lock(tx, caller, shipmentId, 'inventory.pick');
      if (!['ALLOCATED', 'ASSIGNED', 'PICKING'].includes(s.status))
        throw new ConflictError(`A ${s.status} shipment cannot be picked`, {
          details: { reason: 'INVALID_STATE' },
        });
      if (s.holdActive)
        throw new ConflictError('The order is on hold', { details: { reason: 'ON_HOLD' } });
      const allocs = (await this.repo.allocations(s.id, tx)).filter(
        (a) => a.status === 'ALLOCATED',
      );
      const want =
        input.lines ?? allocs.map((a) => ({ allocationId: a.id, qty: a.qty - a.pickedQty }));
      const moves: StockMove[] = [];
      const perLine = new Map<number, number>();
      for (const w of want) {
        const a = allocs.find((x) => x.id === w.allocationId);
        if (a === undefined)
          throw new ValidationError([
            { path: 'body.lines', message: 'allocation is not open on this shipment' },
          ]);
        if (w.qty <= 0) continue;
        if (w.qty > a.qty - a.pickedQty)
          throw new ValidationError([
            { path: 'body.lines', message: `at most ${String(a.qty - a.pickedQty)} left to pick` },
          ]);
        moves.push({
          type: 'PICK',
          from: 'RESERVED',
          to: 'PICKED',
          qty: w.qty,
          source: { id: a.positionId },
          shipmentId: s.id,
        });
        const picked = a.pickedQty + w.qty;
        await this.repo.updateAllocation(tx, a.id, {
          pickedQty: picked,
          ...(picked === a.qty ? { status: 'PICKED' } : {}),
        });
        perLine.set(a.lineNo, (perLine.get(a.lineNo) ?? 0) + w.qty);
      }
      const actor = actorOf(caller);
      await this.deps.shipmentFlow.stock(tx, s, moves, 'PICK', actor);
      for (const [lineNo, qty] of perLine) {
        const l = s.lines.find((x) => x.lineNo === lineNo);
        if (l !== undefined)
          await this.repo.updateLine(tx, s.id, lineNo, { pickedQty: l.pickedQty + qty });
      }
      if (s.status !== 'PICKING') {
        await this.deps.shipmentFlow.move(tx, s, 'PICKING', actor, 'PICK_STARTED');
        const t = await this.repo.openTaskOf(tx, s.id);
        if (t !== null && t.status === 'OPEN')
          await this.repo.updateTask(tx, t.id, { status: 'IN_PROGRESS', startedAt: new Date() });
      }
    });
    return this.state(shipmentId);
  }

  /** Every allocated unit picked → PACKING. */
  async pickComplete(caller: Caller, shipmentId: string) {
    await this.deps.runInTransaction(async (tx) => {
      const s = await this.lock(tx, caller, shipmentId, 'inventory.pick');
      if (s.status !== 'PICKING')
        throw new ConflictError('Picking has not started', {
          details: { reason: 'INVALID_STATE' },
        });
      const open = (await this.repo.allocations(s.id, tx)).filter((a) => a.status === 'ALLOCATED');
      if (open.length > 0)
        throw new ConflictError(`${String(open.length)} lots are not fully picked`, {
          details: { reason: 'PICK_INCOMPLETE', allocationIds: open.map((a) => a.id) },
        });
      await this.deps.shipmentFlow.move(tx, s, 'PACKING', actorOf(caller), 'PICK_COMPLETED');
    });
    return this.state(shipmentId);
  }

  /** Packs every picked lot (PICKED → PACKED) into the listed packages → QC. */
  async pack(
    caller: Caller,
    shipmentId: string,
    input: {
      packages: {
        packageType: 'BAG' | 'BOX' | 'PALLET' | 'DRUM' | 'CAN' | 'CASK' | 'TANK';
        weightKg?: number | null;
        count?: number;
      }[];
    },
  ) {
    await this.deps.runInTransaction(async (tx) => {
      const s = await this.lock(tx, caller, shipmentId, 'fulfilment.manage');
      if (s.status !== 'PACKING')
        throw new ConflictError('Finish picking first', { details: { reason: 'INVALID_STATE' } });
      const picked = (await this.repo.allocations(s.id, tx)).filter((a) => a.status === 'PICKED');
      const moves: StockMove[] = picked.map((a) => ({
        type: 'PACK' as const,
        from: 'PICKED' as const,
        to: 'PACKED' as const,
        qty: a.qty,
        source: { id: a.positionId },
        shipmentId: s.id,
      }));
      const actor = actorOf(caller);
      await this.deps.shipmentFlow.stock(tx, s, moves, 'PACK', actor);
      for (const a of picked) await this.repo.updateAllocation(tx, a.id, { status: 'PACKED' });
      for (const l of s.lines)
        await this.repo.updateLine(tx, s.id, l.lineNo, { packedQty: l.pickedQty });
      const rows: {
        boxNo: number;
        packageType: (typeof input.packages)[number]['packageType'];
        weightKg: string | null;
        createdBy: string;
      }[] = [];
      for (const p of input.packages)
        for (let i = 0; i < (p.count ?? 1); i += 1)
          rows.push({
            boxNo: rows.length + 1,
            packageType: p.packageType,
            weightKg:
              p.weightKg === undefined || p.weightKg === null ? null : p.weightKg.toFixed(3),
            createdBy: caller.userId,
          });
      await this.repo.replacePackages(tx, s.id, rows);
      await this.deps.shipmentFlow.move(tx, s, 'QC', actor, 'PACKED', {
        data: { palletCount: rows.filter((r) => r.packageType === 'PALLET').length },
        note: `${String(rows.length)} packages`,
      });
    });
    return this.state(shipmentId);
  }

  /** QC result: pass keeps it in QC with `qcPassedAt` (ready to stage); fail → back to packing. */
  async qc(
    caller: Caller,
    shipmentId: string,
    input: {
      checks: { key: string; passed: boolean }[];
      tempC?: number | null;
      note?: string | null;
    },
  ) {
    await this.deps.runInTransaction(async (tx) => {
      const s = await this.lock(tx, caller, shipmentId, 'fulfilment.manage');
      if (s.status !== 'QC')
        throw new ConflictError('Pack the shipment first', {
          details: { reason: 'INVALID_STATE' },
        });
      const tpl = await this.deps.fulfilmentSettings.get('fulfilment.qcChecklist', s.warehouseId);
      const missing = tpl.filter((t) => !input.checks.some((c) => c.key === t.key));
      if (missing.length > 0)
        throw new ValidationError(
          missing.map((m) => ({ path: 'body.checks', message: `missing check ${m.key}` })),
        );
      const pass = input.checks.every((c) => c.passed);
      const attempts = await this.repo.qcChecks(s.id, tx);
      await this.repo.addQcCheck(tx, {
        shipmentId: s.id,
        attempt: attempts.length + 1,
        checks: input.checks.map((c) => ({
          ...c,
          label: tpl.find((t) => t.key === c.key)?.label ?? c.key,
        })),
        tempC: input.tempC === undefined || input.tempC === null ? null : input.tempC.toFixed(2),
        result: pass ? 'PASS' : 'FAIL',
        note: input.note ?? null,
        checkedBy: caller.userId,
      });
      const actor = actorOf(caller);
      if (attempts.length === 0)
        await this.repo.bumpDaily(tx, s.warehouseId, istDay(new Date()), {
          qcTotal: 1,
          ...(pass ? { qcFirst: 1 } : {}),
        });
      if (pass) {
        await this.repo.updateShipment(tx, s.id, {
          qcPassedAt: new Date(),
          ...(attempts.length === 0 ? { qcFirstPass: true } : {}),
        });
        await this.deps.shipmentFlow.note(tx, s, 'QC_PASSED', actor, input.note ?? null);
      } else {
        await this.repo.updateShipment(
          tx,
          s.id,
          attempts.length === 0 ? { qcFirstPass: false } : {},
        );
        await this.deps.shipmentFlow.move(tx, s, 'PACKING', actor, 'QC_FAILED', {
          note: input.note ?? null,
        });
        await this.deps.fulfilmentExceptions.raise(tx, {
          type: 'QUALITY',
          cause: 'QC_FAIL',
          severity: 'HIGH',
          warehouseId: s.warehouseId,
          orderId: s.orderId,
          shipmentId: s.id,
          title: `QC failed: ${input.checks
            .filter((c) => !c.passed)
            .map((c) => c.key)
            .join(', ')}`,
          diagnostic: { checks: input.checks, tempC: input.tempC ?? null },
          proposal: { action: 'REPACK' },
          reportedBy: caller.userId,
          dedupeKey: `qc:${s.id}:${String(attempts.length + 1)}`,
        });
      }
    });
    return this.state(shipmentId);
  }

  /** QC passed → staged at a staging area (READY_TO_DISPATCH); the task is done. */
  async stage(
    caller: Caller,
    shipmentId: string,
    input: { stagingAreaId?: string | null; palletCount?: number },
  ) {
    await this.deps.runInTransaction(async (tx) => {
      const s = await this.lock(tx, caller, shipmentId, 'fulfilment.manage');
      if (s.status !== 'QC' || s.qcPassedAt === null)
        throw new ConflictError('QC has not passed', { details: { reason: 'QC_PENDING' } });
      const actor = actorOf(caller);
      await this.deps.shipmentFlow.move(tx, s, 'READY_TO_DISPATCH', actor, 'STAGED', {
        data: {
          stagingAreaId: input.stagingAreaId ?? null,
          ...(input.palletCount === undefined ? {} : { palletCount: input.palletCount }),
        },
      });
      const t = await this.repo.openTaskOf(tx, s.id);
      if (t !== null) {
        await this.repo.updateTask(tx, t.id, { status: 'DONE', completedAt: new Date() });
        if (t.pickBatchId !== null) await this.repo.closePickBatchIfDone(tx, t.pickBatchId);
      }
    });
    return this.state(shipmentId);
  }

  /** W3.07 bulk update: each shipment on its own (one failure never blocks the rest). */
  async bulk(
    caller: Caller,
    input: {
      ids: string[];
      action: 'ASSIGN' | 'PICK_ALL' | 'PICK_COMPLETE' | 'STAGE' | 'PRIORITY';
      assigneeUserId?: string;
      priority?: 'STANDARD' | 'PRIORITY';
      stagingAreaId?: string;
    },
  ) {
    const results: { id: string; ok: boolean; reason: string | null }[] = [];
    for (const id of new Set(input.ids)) {
      try {
        if (input.action === 'ASSIGN') {
          if (input.assigneeUserId === undefined)
            throw new ValidationError([{ path: 'body.assigneeUserId', message: 'is required' }]);
          await this.assign(caller, id, {
            assigneeUserId: input.assigneeUserId,
            ...(input.priority === undefined ? {} : { priority: input.priority }),
          });
        } else if (input.action === 'PICK_ALL') await this.pick(caller, id, {});
        else if (input.action === 'PICK_COMPLETE') await this.pickComplete(caller, id);
        else if (input.action === 'STAGE')
          await this.stage(caller, id, { stagingAreaId: input.stagingAreaId ?? null });
        else
          await this.deps.runInTransaction(async (tx) => {
            const s = await this.lock(tx, caller, id, 'fulfilment.manage');
            await this.repo.updateShipment(tx, s.id, { priority: input.priority ?? 'PRIORITY' });
            await this.deps.shipmentFlow.note(
              tx,
              s,
              'PRIORITY_CHANGED',
              actorOf(caller),
              input.priority ?? 'PRIORITY',
            );
          });
        results.push({ id, ok: true, reason: null });
      } catch (err) {
        results.push({
          id,
          ok: false,
          reason:
            (err as { details?: { reason?: string } }).details?.reason ??
            (err instanceof Error ? err.message.slice(0, 120) : 'ERROR'),
        });
      }
    }
    return { done: results.filter((r) => r.ok).length, results };
  }

  // ── gate-out (called by dispatch inside its trip transaction) ──

  /**
   * READY_TO_DISPATCH → DISPATCHED: packed lots leave (PACKED → DISPATCHED, silent to inventory),
   * allocations ISSUED, lines dispatched, one `dispatchId`, and `shipment.dispatched.v1` so
   * inventory issues the reservation line exactly once (§2a.11).
   */
  async dispatchInTx(tx: Tx, shipmentId: string, actor: FlowActor, note: string | null = null) {
    const s = await this.repo.lockShipment(tx, shipmentId);
    if (s === null) throw new NotFoundError('Shipment');
    if (s.status !== 'READY_TO_DISPATCH')
      throw new ConflictError(`${s.shipmentNo} is ${s.status}, not ready to dispatch`, {
        details: { reason: 'NOT_READY', shipmentId, status: s.status },
      });
    if (s.holdActive)
      throw new ConflictError(`${s.shipmentNo} is on hold`, {
        details: { reason: 'ON_HOLD', shipmentId },
      });
    const packed = (await this.repo.allocations(s.id, tx)).filter((a) => a.status === 'PACKED');
    await this.deps.shipmentFlow.stock(
      tx,
      s,
      packed.map((a) => ({
        type: 'ISSUE' as const,
        from: 'PACKED' as const,
        to: 'DISPATCHED' as const,
        qty: a.qty,
        source: { id: a.positionId },
        shipmentId: s.id,
      })),
      'ISSUE',
      actor,
      note,
      true,
    );
    for (const a of packed) await this.repo.updateAllocation(tx, a.id, { status: 'ISSUED' });
    for (const l of s.lines)
      await this.repo.updateLine(tx, s.id, l.lineNo, { dispatchedQty: l.packedQty });
    const dispatchId = uuidv7();
    await this.deps.shipmentFlow.move(tx, s, 'DISPATCHED', actor, 'DISPATCHED', {
      note,
      data: { dispatchId },
    });
    await this.publishDispatch(
      tx,
      { ...s, dispatchId },
      s.lines.map((l) => ({ variantId: l.variantId, qty: l.packedQty })),
    );
    return { shipmentId: s.id, shipmentNo: s.shipmentNo, dispatchId };
  }

  /** Re-sends `shipment.dispatched.v1` with the SAME dispatchId (reconcile dispatch check). */
  async republishDispatch(tx: Tx, shipmentId: string): Promise<boolean> {
    const s = await this.repo.shipment(shipmentId, tx);
    if (s?.dispatchId == null) return false;
    await this.publishDispatch(
      tx,
      s,
      s.lines.map((l) => ({ variantId: l.variantId, qty: l.dispatchedQty })),
    );
    return true;
  }

  private async publishDispatch(
    tx: Tx,
    s: Pick<ShipmentRow, 'id' | 'orderId' | 'warehouseId'> & { dispatchId: string | null },
    lines: { variantId: string; qty: number }[],
  ) {
    if (s.dispatchId === null) return;
    const merged = new Map<string, number>();
    for (const l of lines)
      if (l.qty > 0) merged.set(l.variantId, (merged.get(l.variantId) ?? 0) + l.qty);
    await emitWarehouseEvent(
      tx,
      'shipment.dispatched.v1',
      {
        dispatchId: s.dispatchId,
        shipmentId: s.id,
        orderId: s.orderId,
        warehouseId: s.warehouseId,
        lines: [...merged].map(([variantId, qty]) => ({ variantId, qty })),
      },
      s.orderId,
    );
  }

  // ── helpers ──

  private async state(shipmentId: string) {
    const s = await this.repo.shipment(shipmentId);
    if (s === null) throw new NotFoundError('Shipment');
    return {
      id: s.id,
      shipmentNo: s.shipmentNo,
      status: s.status,
      qcPassedAt: s.qcPassedAt,
      palletCount: s.palletCount,
      lines: s.lines.map((l) => ({
        lineNo: l.lineNo,
        variantId: l.variantId,
        ordered: l.qty - l.cancelledQty,
        allocated: l.allocatedQty,
        picked: l.pickedQty,
        packed: l.packedQty,
      })),
      version: s.version,
    };
  }

  private taskView(t: TaskRow) {
    const list = t.checklist as unknown as Checklist;
    return {
      id: t.id,
      taskNo: t.taskNo,
      shipmentId: t.shipmentId,
      warehouseId: t.warehouseId,
      type: t.type,
      assigneeUserId: t.assigneeUserId,
      priority: t.priority,
      deadlineAt: t.deadlineAt,
      status: t.status,
      checklist: list,
      checklistDone: list.filter((i) => i.done).length,
      checklistTotal: list.length,
      pickBatchId: t.pickBatchId,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      version: t.version,
    };
  }

  private async lock(
    tx: Tx,
    caller: Caller,
    shipmentId: string,
    key: string,
  ): Promise<ShipmentRow> {
    const s = await this.repo.lockShipment(tx, shipmentId);
    if (s === null) throw new NotFoundError('Shipment');
    caller.access.require(key, s.warehouseId);
    return s;
  }

  private async audit(
    tx: Tx,
    caller: Caller,
    action: string,
    id: string,
    after: unknown,
    reason: string | null = null,
  ) {
    await this.deps.auditService.record(
      tx,
      { userId: caller.userId, ip: caller.ip, requestId: caller.requestId },
      { action, targetType: 'task', targetId: id, after: after as Record<string, unknown>, reason },
    );
  }
}
