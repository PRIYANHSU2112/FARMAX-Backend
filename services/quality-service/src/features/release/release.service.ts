import { ForbiddenError, NotFoundError } from '@farmx/common/errors';
import type { Logger } from '@farmx/common/logger';
import { type RunInTransaction, type Tx, isUniqueViolation } from '@farmx/database';
import type {
  QualityCertificateStatusV1,
  WarehouseQualityTasksPlannedV1,
  WarehouseQualityTaskUpdatedV1,
  WarehouseShipmentBatchesV1,
} from '@farmx/infra/events';

import { emitQualityEvent } from '../../adapters/events.js';
import type { MediaClient } from '../../adapters/media-client.js';
import { nextNumber } from '../../adapters/numbers.js';
import type { QualityConfig } from '../../config/index.js';
import { type Caller, actorOf } from '../../middleware/guards.js';
import { conflict, versionConflict } from '../../middleware/http.js';
import { type Actor, type AuditService, SYSTEM } from '../audit/index.js';
import type { CoasService } from '../coas/index.js';
import type { ProjectionsService } from '../projections/index.js';
import type { SamplesService } from '../samples/index.js';
import type { SpecsService } from '../specs/index.js';
import type { ReleaseRepository } from './release.repository.js';
import type { ChecklistItem, DecisionInput, DecisionKind } from './release.types.js';

const NEW_STATE = { RELEASE: 'RELEASED', QUARANTINE: 'QUARANTINED', RECALL: 'RECALLED' } as const;
const DONE_TASK = new Set(['DONE', 'NO_STOCK', 'SUPERSEDED']);
const today = () => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');

type DecisionRow = NonNullable<Awaited<ReturnType<ReleaseRepository['decision']>>>;

/**
 * W16.07 quality release + quarantine + recall (D-60 points 1–3, 5).
 *  - One transaction: batch-state version bump (optimistic lock) + decision + audit + outbox.
 *  - warehouse-service executes it as one task per warehouse (own tx each) and reports back;
 *    this service mirrors the tasks for progress, PARTIAL results and retries.
 */
export class ReleaseService {
  constructor(
    private readonly deps: {
      releaseRepository: ReleaseRepository;
      runInTransaction: RunInTransaction;
      auditService: AuditService;
      mediaClient: MediaClient;
      projectionsService: ProjectionsService;
      coasService: CoasService;
      specsService: SpecsService;
      samplesService: SamplesService;
      config: QualityConfig;
      logger: Logger;
    },
  ) {}

  private get repo() {
    return this.deps.releaseRepository;
  }

  // ── Release check (W16.07 checklist) ──

  async checklist(batchId: string, tx?: Tx) {
    const { projectionsService, specsService, coasService } = this.deps;
    const batch = await projectionsService.batch(batchId, tx);
    if (batch === null) throw new NotFoundError('Batch');
    const [spec, state, coas] = await Promise.all([
      specsService.policy(batch.variantId, tx),
      this.repo.state(batchId, tx),
      coasService.forBatch(batchId, tx),
    ]);
    const mode = spec?.isActive === true ? spec.releaseMode : 'MANUFACTURER_COA';
    const approved = coas.filter((c) => c.status === 'APPROVED');
    const ind = approved.find((c) => c.source === 'INDEPENDENT') ?? null;
    const mfr = approved.find((c) => c.source === 'MANUFACTURER') ?? null;
    const governing = mode === 'INDEPENDENT_COA' ? ind : (ind ?? mfr);
    const st = state?.state ?? 'PENDING';

    const coaItem: ChecklistItem = {
      key: 'COA_VERIFIED',
      label: 'COA verified',
      state:
        ind?.verdict === 'FAIL' || governing?.verdict === 'FAIL'
          ? 'FAILED'
          : governing?.verdict === 'PASS'
            ? 'REVIEWED'
            : 'PENDING',
      detail:
        governing === null
          ? mode === 'INDEPENDENT_COA'
            ? 'Waiting for the independent COA to be approved'
            : 'Waiting for an approved COA'
          : `${governing.coaNo} (${governing.source.toLowerCase()}) · ${governing.verdict}`,
    };
    const specItem: ChecklistItem = {
      key: 'SPEC_CHECKED',
      label: 'Approved SKU specification checked',
      state:
        spec?.isActive === true && governing !== null && governing.specVersion !== null
          ? 'REVIEWED'
          : 'PENDING',
      detail:
        spec?.isActive === true
          ? `Spec version ${String(spec.version)}`
          : 'No active SKU specification (W16.09)',
    };
    const matched =
      governing !== null &&
      (governing.source === 'INDEPENDENT' || governing.mappingConfirmedAt !== null);
    const matchItem: ChecklistItem = {
      key: 'BATCH_QR_MATCHED',
      label: 'Batch and QR matched',
      state: matched ? 'REVIEWED' : 'PENDING',
      detail: matched ? null : 'Confirm the COA mapping (W16.10)',
    };
    const approvalItem: ChecklistItem = {
      key: 'QA_APPROVAL',
      label: 'Authorized QA approval required',
      state: st === 'RELEASED' ? 'REVIEWED' : 'PENDING',
      detail: null,
    };
    const blockers: string[] = [];
    if (st === 'RECALLED') blockers.push('Batch is recalled and can never be released');
    if (st === 'QUARANTINED')
      blockers.push('Batch is quarantined: release it from Quarantine & Expiry (W14)');
    for (const i of [coaItem, specItem, matchItem])
      if (i.state !== 'REVIEWED') blockers.push(`${i.label}: ${i.detail ?? i.state.toLowerCase()}`);
    return {
      batch,
      mode,
      state: st,
      version: state?.version ?? 0,
      lastDecisionId: state?.lastDecisionId ?? null,
      items: [coaItem, specItem, matchItem, approvalItem],
      blockers,
      canRelease: blockers.length === 0,
      coaIds: [ind?.id, mfr?.id].filter((x): x is string => x !== undefined),
    };
  }

  async releaseCheck(batchId: string) {
    const c = await this.checklist(batchId);
    const [variants, last] = await Promise.all([
      this.deps.projectionsService.variants([c.batch.variantId]),
      c.lastDecisionId === null ? null : this.repo.decision(c.lastDecisionId),
    ]);
    const variant = variants.get(c.batch.variantId);
    return {
      batchId,
      batchNo: c.batch.batchNo,
      product:
        variant === undefined
          ? null
          : {
              variantId: variant.variantId,
              sku: variant.sku,
              name: variant.name,
              variantName: variant.variantName,
            },
      state: c.state,
      /** Send as `expectedVersion` with the decision. */
      version: c.version,
      releaseMode: c.mode,
      banner:
        c.state === 'PENDING'
          ? { code: 'QA_HOLD', text: 'Stock remains unavailable until authorized release.' }
          : c.state === 'RELEASED'
            ? null
            : {
                code: c.state,
                text: 'Batch remains on hold. Missing evidence, failed specification or invalid certificate requires investigation.',
              },
      checklist: c.items,
      canRelease: c.canRelease,
      blockers: c.blockers,
      lastDecision: last === null ? null : this.view(last),
    };
  }

  // ── Decisions ──

  async decide(caller: Caller, batchId: string, input: DecisionInput, idempotencyKey: string) {
    this.requireKind(caller, input.kind);
    const prior = await this.repo.decisionByKey(idempotencyKey);
    if (prior !== null) return this.replay(prior, batchId, input.kind);
    const evidenceKeys = (input.evidence ?? []).map(
      (r, i) => this.deps.mediaClient.verify(r, caller.userId, `body.evidence[${String(i)}]`).key,
    );
    try {
      const id = await this.deps.runInTransaction((tx) =>
        this.decideInTx(
          tx,
          actorOf(caller),
          {
            batchId,
            kind: input.kind,
            remarks: input.remarks,
            evidenceKeys,
            expectedVersion: input.expectedVersion,
            idempotencyKey,
          },
          caller.requestId,
        ),
      );
      return await this.get(id);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const again = await this.repo.decisionByKey(idempotencyKey);
      if (again !== null) return this.replay(again, batchId, input.kind);
      throw conflict(
        'RELEASE_IN_PROGRESS',
        'A release of this batch is still being applied; wait for it to finish',
      );
    }
  }

  /**
   * Core decision, inside the caller's transaction. Returns the decision id. The batch-state
   * UPDATE … WHERE version = expectedVersion is the gate: a second concurrent decision on the
   * same version updates 0 rows → 409 VERSION_CONFLICT (D-60 point 3).
   */
  async decideInTx(
    tx: Tx,
    actor: Actor,
    d: {
      batchId: string;
      kind: DecisionKind;
      remarks: string;
      evidenceKeys: string[];
      expectedVersion: number;
      idempotencyKey: string;
    },
    correlationId: string,
  ): Promise<string> {
    if (actor.userId === null) throw new Error('decideInTx: a decision needs a person');
    await this.repo.ensureState(tx, d.batchId);
    const check = await this.checklist(d.batchId, tx);
    if (check.state === 'RECALLED')
      throw conflict('ALREADY_RECALLED', 'This batch is recalled; no further decision is possible');
    if (d.kind === 'RELEASE' && !check.canRelease)
      throw conflict('RELEASE_BLOCKED', 'This batch cannot be released yet', {
        blockers: check.blockers,
      });

    if (
      !(await this.repo.updateStateVersioned(tx, d.batchId, d.expectedVersion, {
        state: NEW_STATE[d.kind],
        updatedBy: actor.userId,
      }))
    ) {
      const last =
        check.lastDecisionId === null ? null : await this.repo.decision(check.lastDecisionId, tx);
      throw versionConflict(check.version, {
        lastDecision:
          last === null
            ? null
            : {
                decisionNo: last.decisionNo,
                kind: last.kind,
                decidedBy: last.decidedBy,
                decidedAt: last.decidedAt.toISOString(),
              },
      });
    }
    const stateVersion = d.expectedVersion + 1;
    const decision = await this.repo.createDecision(tx, {
      decisionNo: await nextNumber(tx, 'QD'),
      batchId: d.batchId,
      kind: d.kind,
      remarks: d.remarks,
      evidenceKeys: d.evidenceKeys,
      checklist: JSON.parse(
        JSON.stringify({ mode: check.mode, items: check.items, blockers: check.blockers }),
      ) as object,
      coaIds: check.coaIds,
      expectedVersion: d.expectedVersion,
      stateVersion,
      idempotencyKey: d.idempotencyKey,
      decidedBy: actor.userId,
    });
    await this.repo.setLastDecision(tx, d.batchId, decision.id);
    await this.deps.auditService.record(tx, actor, {
      action: `decision.${d.kind.toLowerCase()}`,
      targetType: 'batch',
      targetId: d.batchId,
      before: { state: check.state, version: check.version },
      after: {
        state: NEW_STATE[d.kind],
        version: stateVersion,
        decisionId: decision.id,
        decisionNo: decision.decisionNo,
      },
      reason: d.remarks,
    });
    await emitQualityEvent(
      tx,
      'quality.decision_requested.v1',
      {
        decisionId: decision.id,
        decisionNo: decision.decisionNo,
        batchId: d.batchId,
        kind: d.kind,
        stateVersion,
        actorUserId: actor.userId,
        reason: d.remarks,
      },
      correlationId,
    );
    await this.emitBatchState(tx, d.batchId, correlationId);
    if (d.kind === 'RECALL')
      await this.recallNotices(tx, decision.id, d.batchId, null, correlationId);
    return decision.id;
  }

  /** Independent COA failed → automatic recall in the approver's transaction (once per COA). */
  async recallInTx(
    tx: Tx,
    actor: Actor,
    batchId: string,
    reason: string,
    key: string,
    correlationId: string,
  ) {
    const st = await this.repo.ensureState(tx, batchId);
    if (st.state === 'RECALLED') return null;
    return this.decideInTx(
      tx,
      actor,
      {
        batchId,
        kind: 'RECALL',
        remarks: reason,
        evidenceKeys: [],
        expectedVersion: st.version,
        idempotencyKey: key,
      },
      correlationId,
    );
  }

  async get(id: string) {
    const d = await this.repo.decision(id);
    if (d === null) throw new NotFoundError('Decision');
    const urls = await this.deps.mediaClient.signRead(d.evidenceKeys);
    return { ...this.view(d), evidence: d.evidenceKeys.map((k) => ({ url: urls[k] ?? null })) };
  }

  async list(batchId: string) {
    return (await this.repo.decisionsOfBatch(batchId)).map((d) => this.view(d));
  }

  /** Re-run the FAILED warehouse tasks (same task keys → never a double move). */
  async retry(caller: Caller, id: string) {
    const d = await this.repo.decision(id);
    if (d === null) throw new NotFoundError('Decision');
    this.requireKind(caller, d.kind);
    const failed = d.tasks.filter((t) => t.status === 'FAILED').map((t) => t.warehouseId);
    if (failed.length === 0)
      throw conflict('NOTHING_TO_RETRY', 'No warehouse of this decision has failed');
    await this.deps.runInTransaction(async (tx) => {
      await this.repo.resetFailed(tx, id, failed);
      await this.repo.updateDecision(tx, id, {
        status: 'APPLYING',
        completedAt: null,
        warehousesFailed: 0,
      });
      await this.deps.auditService.record(tx, actorOf(caller), {
        action: 'decision.retried',
        targetType: 'decision',
        targetId: id,
        after: { warehouseIds: failed },
      });
      await emitQualityEvent(
        tx,
        'quality.decision_retry_requested.v1',
        { decisionId: id, batchId: d.batchId, warehouseIds: failed, actorUserId: caller.userId },
        caller.requestId,
      );
    });
    return this.get(id);
  }

  /** Job: decisions still applying after DECISION_STUCK_MINUTES (screens show `stuck`). */
  async sweepStuck(): Promise<number> {
    const before = new Date(Date.now() - this.deps.config.DECISION_STUCK_MINUTES * 60_000);
    const stuck = await this.repo.stuck(before);
    if (stuck.length > 0) this.deps.logger.warn({ stuck }, 'quality decisions still applying');
    return stuck.length;
  }

  // ── For other features ──

  /** Batch states (customer cards). */
  async statesOf(batchIds: readonly string[]) {
    if (batchIds.length === 0) return new Map<string, { state: string; version: number }>();
    return new Map((await this.repo.states(batchIds)).map((s) => [s.batchId, s]));
  }

  /** Quarantine / recall decisions of batches, newest first (customer timelines). */
  async holdsOf(batchIds: readonly string[]) {
    if (batchIds.length === 0) return [];
    return this.repo.decisionsOf(batchIds, ['RECALL', 'QUARANTINE']);
  }

  /** Every batch of a receipt gets a PENDING state row (receipt event). */
  async ensureStates(tx: Tx, batchIds: readonly string[]): Promise<void> {
    if (batchIds.length > 0) await this.repo.ensureStates(tx, batchIds);
  }

  // ── Batch read copy + recall notices ──

  /** What warehouse-service keeps on the batch (certificate status, blocked flag). */
  async certificateStatus(
    batchId: string,
    tx?: Tx,
  ): Promise<{ status: QualityCertificateStatusV1; coaRef: string | null }> {
    const coas = await this.deps.coasService.forBatch(batchId, tx);
    const ind = coas.find((c) => c.source === 'INDEPENDENT' && c.status === 'APPROVED');
    if (ind?.verdict === 'FAIL') return { status: 'REJECTED', coaRef: ind.coaNo };
    const valid = coas
      .filter(
        (c) =>
          c.status === 'APPROVED' &&
          c.verdict === 'PASS' &&
          (c.validUntil === null || c.validUntil >= today()),
      )
      .sort((a, b) => (a.source === b.source ? 0 : a.source === 'INDEPENDENT' ? -1 : 1))[0];
    if (valid !== undefined) return { status: 'VALID', coaRef: valid.coaNo };
    const expired = coas.find((c) => c.status === 'EXPIRED');
    if (expired !== undefined) return { status: 'EXPIRED', coaRef: expired.coaNo };
    const sampleNo = await this.deps.samplesService.firstNoOfBatch(batchId, tx);
    return sampleNo === null
      ? { status: 'NONE', coaRef: null }
      : { status: 'SAMPLE_REFERENCE', coaRef: sampleNo };
  }

  async emitBatchState(tx: Tx, batchId: string, correlationId: string): Promise<void> {
    const st = await this.repo.ensureState(tx, batchId);
    const cert = await this.certificateStatus(batchId, tx);
    await emitQualityEvent(
      tx,
      'quality.batch_state_changed.v1',
      {
        batchId,
        state: st.state,
        qualityBlocked: st.state === 'QUARANTINED' || st.state === 'RECALLED',
        certificateStatus: cert.status,
        coaRef: cert.coaRef,
        version: st.version,
      },
      correlationId,
    );
  }

  /**
   * Recall notices, once per (decision, buyer): every known buyer at recall time, and later
   * buyers as their shipment events arrive (`only` = that one buyer).
   */
  private async recallNotices(
    tx: Tx,
    decisionId: string,
    batchId: string,
    only: { userId: string; orderId: string; orderNo: string } | null,
    correlationId: string,
  ) {
    const { projectionsService } = this.deps;
    const candidates =
      only === null
        ? (await projectionsService.buyersOf(tx, batchId)).map((b) => ({
            userId: b.customerUserId,
            orderId: b.orderId,
            orderNo: b.orderNo,
          }))
        : [only];
    const fresh: typeof candidates = [];
    for (const b of candidates)
      if (
        (await this.repo.insertNotice(tx, decisionId, b.userId)) ||
        fresh.some((f) => f.userId === b.userId)
      )
        fresh.push(b);
    if (only !== null && fresh.length === 0) return;
    const batch = await projectionsService.batch(batchId, tx);
    if (batch === null) return;
    const [variants, cnNos] = await Promise.all([
      projectionsService.variants([batch.variantId]),
      projectionsService.cnNosOf(batchId, tx),
    ]);
    const variant = variants.get(batch.variantId);
    await emitQualityEvent(
      tx,
      'quality.batch_recalled.v1',
      {
        decisionId,
        batchId,
        batchNo: batch.batchNo,
        variantId: batch.variantId,
        productName:
          variant === undefined ? batch.batchNo : `${variant.name} · ${variant.variantName}`,
        cnNos,
        buyers: fresh,
      },
      correlationId,
    );
  }

  /** A shipment of an already-recalled batch left after the recall: tell that buyer too. */
  async noticeLateBuyer(
    tx: Tx,
    d: WarehouseShipmentBatchesV1,
    batchIds: string[],
    correlationId: string,
  ) {
    for (const batchId of batchIds) {
      const st = await this.repo.state(batchId, tx);
      if (st?.state !== 'RECALLED' || st.lastDecisionId === null) continue;
      await this.recallNotices(
        tx,
        st.lastDecisionId,
        batchId,
        { userId: d.customerUserId, orderId: d.orderId, orderNo: d.orderNo },
        correlationId,
      );
    }
  }

  // ── Warehouse progress (event handlers) ──

  async onTasksPlanned(tx: Tx, e: WarehouseQualityTasksPlannedV1): Promise<void> {
    const d = await this.repo.decision(e.decisionId, tx);
    if (d === null) return;
    await this.repo.insertTasks(tx, e.decisionId, e.warehouseIds);
    await this.repo.updateDecision(tx, e.decisionId, { plannedAt: d.plannedAt ?? new Date() });
    await this.recompute(tx, e.decisionId);
  }

  async onTaskUpdated(tx: Tx, e: WarehouseQualityTaskUpdatedV1): Promise<void> {
    const d = await this.repo.decision(e.decisionId, tx);
    if (d === null) return;
    await this.repo.upsertTask(tx, e.decisionId, e.warehouseId, {
      status: e.status,
      qtyMoved: e.qtyMoved,
      attempts: e.attempts,
      lastError: e.error?.slice(0, 500) ?? null,
    });
    await this.recompute(tx, e.decisionId);
  }

  private async recompute(tx: Tx, decisionId: string): Promise<void> {
    const d = await this.repo.decision(decisionId, tx);
    if (d?.plannedAt == null) return;
    const done = d.tasks.filter((t) => DONE_TASK.has(t.status)).length;
    const failed = d.tasks.filter((t) => t.status === 'FAILED').length;
    const pending = d.tasks.length - done - failed;
    const status =
      pending > 0 ? 'APPLYING' : failed === 0 ? 'APPLIED' : done > 0 ? 'PARTIAL' : 'FAILED';
    await this.repo.updateDecision(tx, decisionId, {
      status,
      warehousesTotal: d.tasks.length,
      warehousesDone: done,
      warehousesFailed: failed,
      completedAt: status === 'APPLYING' ? null : (d.completedAt ?? new Date()),
    });
    if (status !== d.status && status !== 'APPLYING')
      await this.deps.auditService.record(tx, SYSTEM, {
        action: `decision.${status.toLowerCase()}`,
        targetType: 'decision',
        targetId: decisionId,
        before: { status: d.status },
        after: { status, done, failed, total: d.tasks.length },
      });
  }

  // ── helpers ──

  /** RELEASE: quality.hold_release (GLOBAL) · QUARANTINE: quality.hold_create · RECALL: quality.recall_initiate (GLOBAL). */
  private requireKind(caller: Caller, kind: string) {
    const allowed =
      kind === 'RELEASE'
        ? caller.access.isGlobal('quality.hold_release')
        : kind === 'RECALL'
          ? caller.access.isGlobal('quality.recall_initiate')
          : caller.access.holdsAnywhere('quality.hold_create') ||
            caller.access.isGlobal('quality.hold_release');
    if (!allowed) throw new ForbiddenError();
  }

  private replay(
    d: { id: string; batchId: string; kind: string },
    batchId: string,
    kind: DecisionKind,
  ) {
    if (d.batchId !== batchId || d.kind !== kind)
      throw conflict(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for another decision',
      );
    return this.get(d.id);
  }

  private view(d: DecisionRow) {
    const stuckAfter = this.deps.config.DECISION_STUCK_MINUTES * 60_000;
    const done = d.tasks.filter((t) => DONE_TASK.has(t.status)).length;
    return {
      id: d.id,
      decisionNo: d.decisionNo,
      batchId: d.batchId,
      kind: d.kind,
      status: d.status,
      remarks: d.remarks,
      checklist: d.checklist,
      coaIds: d.coaIds,
      stateVersion: d.stateVersion,
      decidedBy: d.decidedBy,
      decidedAt: d.decidedAt.toISOString(),
      plannedAt: d.plannedAt?.toISOString() ?? null,
      completedAt: d.completedAt?.toISOString() ?? null,
      stuck: d.status === 'APPLYING' && Date.now() - d.decidedAt.getTime() > stuckAfter,
      progress: {
        total: d.plannedAt === null ? null : d.tasks.length,
        done,
        failed: d.tasks.filter((t) => t.status === 'FAILED').length,
        pending: d.tasks.filter((t) => t.status === 'PENDING').length,
      },
      tasks: d.tasks.map((t) => ({
        warehouseId: t.warehouseId,
        status: t.status,
        qtyMoved: t.qtyMoved,
        attempts: t.attempts,
        lastError: t.lastError,
        updatedAt: t.updatedAt.toISOString(),
      })),
    };
  }
}
