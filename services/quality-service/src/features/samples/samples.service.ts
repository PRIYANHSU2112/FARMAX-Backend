import { NotFoundError, ValidationError } from '@farmx/common/errors';
import type { RunInTransaction, Tx } from '@farmx/database';
import type { WarehouseReceiptCreatedV1 } from '@farmx/infra/events';

import { nextNumber } from '../../adapters/numbers.js';
import { type Caller, actorOf } from '../../middleware/guards.js';
import { conflict, versionConflict } from '../../middleware/http.js';
import { requireAt, warehouseWhere } from '../../middleware/scope.js';
import { type Actor, type AuditService, SYSTEM } from '../audit/index.js';
import type { CoasService } from '../coas/index.js';
import type { LabsService } from '../labs/index.js';
import type { ProjectionsService } from '../projections/index.js';
import type { SpecsService } from '../specs/index.js';
import type { SampleWhere, SamplesRepository } from './samples.repository.js';
import {
  BUCKET_STATUSES,
  type Bucket,
  FROM,
  type SampleAction,
  type SampleStatus,
  bucketOf,
  expectedResultAt,
  labStepAllowed,
  labSteps,
} from './samples.rules.js';
import type { SampleActionInput, SampleCreateInput, SampleListQuery } from './samples.types.js';

type SampleRow = NonNullable<Awaited<ReturnType<SamplesRepository['byId']>>>;
const RESULT_FROM: readonly SampleStatus[] = [
  'SENT',
  'ACKNOWLEDGED',
  'TESTING',
  'RESULTS_RECEIVED',
];

/**
 * W16.01–W16.04 samples. Every step is one transaction: optimistic version check + status
 * change + timeline event + audit row (D-60 points 1, 3 and 5).
 */
export class SamplesService {
  constructor(
    private readonly deps: {
      samplesRepository: SamplesRepository;
      runInTransaction: RunInTransaction;
      auditService: AuditService;
      labsService: LabsService;
      specsService: SpecsService;
      projectionsService: ProjectionsService;
      coasService: CoasService;
    },
  ) {}

  private get repo() {
    return this.deps.samplesRepository;
  }

  /** W16.01 cards: counts per bucket in the caller's warehouses. */
  async summary(caller: Caller, warehouseId?: string) {
    if (warehouseId !== undefined) requireAt(caller, 'quality.view', warehouseId, 'Warehouse');
    const rows = await this.repo.countByStatus(
      warehouseId === undefined ? warehouseWhere(caller, 'quality.view') : { warehouseId },
    );
    const out: Record<Bucket, number> = {
      pending: 0,
      testing: 0,
      passed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const r of rows) out[bucketOf(r.status)] += r._count._all;
    return out;
  }

  async list(caller: Caller, q: SampleListQuery) {
    if (q.warehouseId !== undefined) requireAt(caller, 'quality.view', q.warehouseId, 'Warehouse');
    const term = q.q?.trim();
    const where: SampleWhere = {
      ...(q.warehouseId === undefined
        ? warehouseWhere(caller, 'quality.view')
        : { warehouseId: q.warehouseId }),
      ...(q.status !== undefined
        ? { status: q.status }
        : q.bucket === undefined
          ? {}
          : { status: { in: BUCKET_STATUSES[q.bucket] } }),
      ...(q.labId === undefined ? {} : { labId: q.labId }),
      ...(q.batchId === undefined ? {} : { batchId: q.batchId }),
    };
    if (term !== undefined && term !== '') {
      const batchIds = await this.deps.projectionsService.batchIdsByNoContaining(term);
      where.OR = [
        { sampleNo: { contains: term, mode: 'insensitive' } },
        { cnNo: { contains: term, mode: 'insensitive' } },
        { batchId: { in: batchIds } },
      ];
    }
    const rows = await this.repo.list(where, q.cursor, q.limit + 1);
    const page = rows.slice(0, q.limit);
    const ctx = await this.context(page);
    return {
      items: page.map((s) => this.row(s, ctx)),
      nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null,
      limit: q.limit,
    };
  }

  async get(caller: Caller, id: string) {
    const s = await this.repo.byId(id);
    if (s === null || !caller.access.can('quality.view', s.warehouseId))
      throw new NotFoundError('Sample');
    const [ctx, events, coa] = await Promise.all([
      this.context([s]),
      this.repo.events(id),
      this.deps.coasService.summaryOfSample(id),
    ]);
    return {
      ...this.row(s, ctx),
      receiptId: s.receiptId,
      collectedAt: s.collectedAt?.toISOString() ?? null,
      collectedBy: s.collectedBy,
      sentAt: s.sentAt?.toISOString() ?? null,
      acknowledgedAt: s.acknowledgedAt?.toISOString() ?? null,
      testingAt: s.testingAt?.toISOString() ?? null,
      resultsAt: s.resultsAt?.toISOString() ?? null,
      closedAt: s.closedAt?.toISOString() ?? null,
      steps: labSteps(s.status),
      coa,
      timeline: events.map((e) => ({
        at: e.at.toISOString(),
        type: e.type,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        note: e.note,
        actorUserId: e.actorUserId,
      })),
      actions: this.actions(s, coa),
    };
  }

  async create(caller: Caller, input: SampleCreateInput) {
    const { runInTransaction, labsService, specsService, projectionsService } = this.deps;
    requireAt(caller, 'quality.hold_create', input.warehouseId, 'Warehouse');
    const batch = await projectionsService.batch(input.batchId);
    if (batch === null) throw new NotFoundError('Batch');
    const line = await projectionsService.latestReceiptLine(
      input.batchId,
      input.warehouseId,
      input.cnNo,
    );
    if (line === null)
      throw new ValidationError([
        {
          path: input.cnNo === undefined ? 'body.batchId' : 'body.cnNo',
          message: 'this batch was not received at this warehouse under that consignment',
        },
      ]);
    const spec = await specsService.policy(batch.variantId);
    const labId = input.labId ?? spec?.defaultLabId ?? undefined;
    if (labId === undefined)
      throw new ValidationError([{ path: 'body.labId', message: 'choose a laboratory' }]);
    await labsService.requireActive(labId);
    return runInTransaction(async (tx) => {
      const s = await this.insert(tx, actorOf(caller), {
        batchId: batch.batchId,
        variantId: batch.variantId,
        warehouseId: input.warehouseId,
        receiptId: line.receiptId,
        cnNo: line.cnNo,
        qty: input.qty,
        qtyUnit: input.qtyUnit ?? spec?.sampleUnit ?? 'units',
        labId,
        source: 'MANUAL',
        note: null,
      });
      return { id: s.id, sampleNo: s.sampleNo, status: s.status, version: s.version };
    });
  }

  /**
   * AUTO sample per batch of a receipt that landed in QC_HOLD and has an active spec with
   * sampleOnReceipt (inside the inbox transaction). The partial unique index makes a second
   * AUTO sample for the same (receipt, batch) impossible even under concurrent delivery.
   */
  async autoFromReceipt(tx: Tx, d: WarehouseReceiptCreatedV1): Promise<void> {
    // Vendor receipts only: transfers and returns move stock that was already sampled.
    if (d.sourceType !== 'VENDOR') return;
    const held = new Map<string, string>();
    for (const l of d.lines)
      if (l.initialStatus === 'QC_HOLD') held.set(l.batchId, l.variant.variantId);
    for (const [batchId, variantId] of held) {
      const spec = await this.deps.specsService.policy(variantId, tx);
      if (spec?.isActive !== true || !spec.sampleOnReceipt) continue;
      if ((await this.repo.findAuto(tx, d.receiptId, batchId)) !== null) continue;
      const lab = await this.deps.labsService.firstActive(tx, spec.defaultLabId);
      if (lab === null) {
        await this.deps.auditService.record(tx, SYSTEM, {
          action: 'sample.auto_skipped',
          targetType: 'batch',
          targetId: batchId,
          warehouseId: d.warehouseId,
          reason: 'No active laboratory: create the sample by hand',
        });
        continue;
      }
      await this.insert(tx, SYSTEM, {
        batchId,
        variantId,
        warehouseId: d.warehouseId,
        receiptId: d.receiptId,
        cnNo: d.cnNo,
        qty: spec.sampleQty,
        qtyUnit: spec.sampleUnit,
        labId: lab.id,
        source: 'AUTO',
        note: `Sample drawn by system instruction · ${String(spec.sampleQty)} ${spec.sampleUnit} at random`,
      });
    }
  }

  /** collect · send · lab-status · flag · cancel (W16.03 / W16.04 buttons). */
  async act(caller: Caller, id: string, action: SampleAction, input: SampleActionInput) {
    const { runInTransaction, auditService, labsService } = this.deps;
    const before = await this.repo.byId(id);
    if (before === null) throw new NotFoundError('Sample');
    requireAt(caller, 'quality.hold_create', before.warehouseId, 'Sample');
    const at = input.at === undefined ? new Date() : new Date(input.at);
    if (at.getTime() > Date.now() + 5 * 60_000)
      throw new ValidationError([{ path: 'body.at', message: 'cannot be in the future' }]);

    let to: SampleStatus = before.status;
    let data: Record<string, unknown> = {};
    switch (action) {
      case 'collect':
        to = 'COLLECTED';
        data = { collectedAt: at, collectedBy: caller.userId };
        break;
      case 'send': {
        to = 'SENT';
        const lab = await labsService.requireActive(before.labId);
        data = {
          sentAt: at,
          sentBy: caller.userId,
          expectedResultAt: expectedResultAt(at, lab.tatDays),
          ...(input.labRef === undefined ? {} : { labRef: input.labRef }),
        };
        break;
      }
      case 'lab-status': {
        if (input.status === undefined)
          throw new ValidationError([{ path: 'body.status', message: 'is required' }]);
        to = input.status;
        if (!labStepAllowed(before.status, to))
          throw conflict(
            'INVALID_TRANSITION',
            `A ${before.status.toLowerCase()} sample cannot move to ${to.toLowerCase()}`,
          );
        const stamp = {
          ACKNOWLEDGED: 'acknowledgedAt',
          TESTING: 'testingAt',
          RESULTS_RECEIVED: 'resultsAt',
        }[input.status];
        data = { [stamp]: at, ...(input.labRef === undefined ? {} : { labRef: input.labRef }) };
        break;
      }
      case 'flag':
        if (input.note === undefined)
          throw new ValidationError([{ path: 'body.note', message: 'say what is wrong' }]);
        break;
      case 'cancel':
        if (input.note === undefined)
          throw new ValidationError([
            { path: 'body.note', message: 'say why the sample is cancelled' },
          ]);
        to = 'CANCELLED';
        data = { closedAt: new Date() };
        break;
    }
    const allowedFrom: readonly SampleStatus[] =
      action === 'lab-status' ? [before.status] : FROM[action];
    if (!allowedFrom.includes(before.status))
      throw conflict(
        'INVALID_TRANSITION',
        `Cannot ${action.replace('-', ' ')} a ${before.status.toLowerCase().replace('_', ' ')} sample`,
      );

    return runInTransaction(async (tx) => {
      if (
        !(await this.repo.updateVersioned(tx, id, input.expectedVersion, [before.status], {
          ...data,
          status: to,
        }))
      ) {
        const cur = await this.repo.byId(id, tx);
        throw versionConflict(cur?.version ?? null, { status: cur?.status ?? null });
      }
      await this.repo.insertEvent(tx, {
        sampleId: id,
        type: action === 'lab-status' ? to : action.toUpperCase(),
        fromStatus: before.status,
        toStatus: to,
        note: input.note ?? (input.labRef === undefined ? null : `Lab reference ${input.labRef}`),
        actorUserId: caller.userId,
      });
      const after = await this.repo.byId(id, tx);
      if (after === null) throw new NotFoundError('Sample');
      await auditService.record(tx, actorOf(caller), {
        action: `sample.${action === 'lab-status' ? 'lab_status' : action}`,
        targetType: 'sample',
        targetId: id,
        warehouseId: before.warehouseId,
        before: { status: before.status, version: before.version },
        after: { status: after.status, version: after.version, labRef: after.labRef },
        reason: input.note ?? null,
      });
      return {
        id,
        sampleNo: after.sampleNo,
        status: after.status,
        version: after.version,
        steps: labSteps(after.status),
      };
    });
  }

  // ── For other features (inside their transactions) ──

  /** A sample row (COA feature). */
  async raw(id: string) {
    return this.repo.byId(id);
  }

  /** Results entered: → RESULTS_RECEIVED with the caller's expected sample version (409 if stale). */
  async markResults(tx: Tx, actor: Actor, sampleId: string, expectedVersion: number) {
    const s = await this.repo.byId(sampleId, tx);
    if (s === null) throw new NotFoundError('Sample');
    if (!RESULT_FROM.includes(s.status))
      throw conflict(
        'INVALID_TRANSITION',
        'Results can be entered only after the sample was sent to the lab',
      );
    if (
      !(await this.repo.updateVersioned(tx, sampleId, expectedVersion, RESULT_FROM, {
        status: 'RESULTS_RECEIVED',
        resultsAt: s.resultsAt ?? new Date(),
      }))
    )
      throw versionConflict(s.version);
    if (s.status !== 'RESULTS_RECEIVED')
      await this.repo.insertEvent(tx, {
        sampleId,
        type: 'RESULTS_RECEIVED',
        fromStatus: s.status,
        toStatus: 'RESULTS_RECEIVED',
        actorUserId: actor.userId,
      });
    return s;
  }

  /** COA approved / sent back: close the sample (PASSED / FAILED) or reopen it (TESTING). */
  async setOutcome(
    tx: Tx,
    actor: Actor,
    sampleId: string,
    to: 'PASSED' | 'FAILED' | 'TESTING',
    note: string | null,
  ) {
    const s = await this.repo.byId(sampleId, tx);
    if (s === null) throw new NotFoundError('Sample');
    if (
      !(await this.repo.updateVersioned(tx, sampleId, s.version, [s.status], {
        status: to,
        closedAt: to === 'TESTING' ? null : new Date(),
      }))
    )
      throw versionConflict(s.version);
    await this.repo.insertEvent(tx, {
      sampleId,
      type: to === 'TESTING' ? 'RESULTS_REJECTED' : to,
      fromStatus: s.status,
      toStatus: to,
      note,
      actorUserId: actor.userId,
    });
  }

  /** Latest sample per lab ("Sample mapping" on W16.08). */
  async latestPerLab(labIds: readonly string[]) {
    if (labIds.length === 0) return new Map<string, { sampleNo: string; at: Date }>();
    const rows = await this.repo.latestPerLab(labIds);
    return new Map(rows.map((r) => [r.labId, { sampleNo: r.sampleNo, at: r.createdAt }]));
  }

  /** Any sample number of a batch (certificate status SAMPLE_REFERENCE). */
  async firstNoOfBatch(batchId: string, tx?: Tx): Promise<string | null> {
    return (await this.repo.firstOfBatch(batchId, tx))?.sampleNo ?? null;
  }

  /** Non-cancelled samples of batches, newest first (customer cards). */
  async ofBatches(batchIds: readonly string[]) {
    if (batchIds.length === 0) return [];
    return this.repo.ofBatches(batchIds);
  }

  // ── helpers ──

  private async insert(
    tx: Tx,
    actor: Actor,
    v: {
      batchId: string;
      variantId: string;
      warehouseId: string;
      receiptId: string | null;
      cnNo: string | null;
      qty: number;
      qtyUnit: string;
      labId: string;
      source: 'AUTO' | 'MANUAL';
      note: string | null;
    },
  ) {
    const { note, ...data } = v;
    const s = await this.repo.insert(tx, {
      ...data,
      sampleNo: await nextNumber(tx, 'SMP'),
      createdBy: actor.userId,
    });
    await this.repo.insertEvent(tx, {
      sampleId: s.id,
      type: 'CREATED',
      toStatus: 'PENDING',
      note,
      actorUserId: actor.userId,
    });
    await this.deps.auditService.record(tx, actor, {
      action: v.source === 'AUTO' ? 'sample.auto_created' : 'sample.created',
      targetType: 'sample',
      targetId: s.id,
      warehouseId: v.warehouseId,
      after: {
        sampleNo: s.sampleNo,
        batchId: v.batchId,
        qty: v.qty,
        labId: v.labId,
        source: v.source,
      },
    });
    return s;
  }

  /** Batch, product and lab names of a page of samples. */
  private async context(rows: SampleRow[]) {
    const { projectionsService, labsService } = this.deps;
    const [batches, variants, labs] = await Promise.all([
      projectionsService.batches(rows.map((r) => r.batchId)),
      projectionsService.variants(rows.map((r) => r.variantId)),
      labsService.byIds(rows.map((r) => r.labId)),
    ]);
    return { batches, variants, labs };
  }

  private row(s: SampleRow, ctx: Awaited<ReturnType<SamplesService['context']>>) {
    const b = ctx.batches.get(s.batchId);
    const v = ctx.variants.get(s.variantId);
    const lab = ctx.labs.get(s.labId);
    return {
      id: s.id,
      sampleNo: s.sampleNo,
      status: s.status,
      bucket: bucketOf(s.status),
      source: s.source,
      batchId: s.batchId,
      batchNo: b?.batchNo ?? null,
      product:
        v === undefined
          ? null
          : { variantId: v.variantId, sku: v.sku, name: v.name, variantName: v.variantName },
      warehouseId: s.warehouseId,
      cnNo: s.cnNo,
      qty: s.qty,
      qtyUnit: s.qtyUnit,
      lab: lab === undefined ? null : { id: lab.id, name: lab.name, type: lab.type },
      labRef: s.labRef,
      expectedResultAt: s.expectedResultAt?.toISOString() ?? null,
      version: s.version,
      createdAt: s.createdAt.toISOString(),
    };
  }

  private actions(s: SampleRow, coa: { status: string } | null): string[] {
    const out: string[] = [];
    if (FROM.collect.includes(s.status)) out.push('collect');
    if (FROM.send.includes(s.status)) out.push('send');
    if (['SENT', 'ACKNOWLEDGED', 'TESTING'].includes(s.status)) out.push('lab-status');
    if (RESULT_FROM.includes(s.status)) out.push('enter-results');
    if (coa?.status === 'RESULTS_ENTERED') out.push('review');
    if (FROM.flag.includes(s.status)) out.push('flag');
    if (FROM.cancel.includes(s.status)) out.push('cancel');
    return out;
  }
}
