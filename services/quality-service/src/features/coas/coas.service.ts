import { NotFoundError, ValidationError } from '@farmx/common/errors';
import type { RunInTransaction, Tx } from '@farmx/database';

import { emitQualityEvent } from '../../adapters/events.js';
import type { MediaClient } from '../../adapters/media-client.js';
import { nextNumber } from '../../adapters/numbers.js';
import { type Caller, actorOf } from '../../middleware/guards.js';
import { conflict, toDate, versionConflict, ymd } from '../../middleware/http.js';
import { requireAt, requireForBatch } from '../../middleware/scope.js';
import { type Actor, type AuditService, SYSTEM } from '../audit/index.js';
import type { CertificatesService } from '../certificates/index.js';
import type { LabsService } from '../labs/index.js';
import type { ProjectionsService } from '../projections/index.js';
import type { ReleaseService } from '../release/index.js';
import type { SamplesService } from '../samples/index.js';
import {
  type ParamVerdict,
  type SpecParam,
  type SpecsService,
  judge,
  mismatch,
  overallVerdict,
  specLabel,
} from '../specs/index.js';
import type { CoasRepository } from './coas.repository.js';
import type {
  CertificateFields,
  CoaListQuery,
  ResultInput,
  ResultsInput,
  ReviewInput,
  SampleResultsInput,
  UploadInput,
} from './coas.types.js';

const NOTE = 'Acceptance limits require approved SKU-specific specifications.';
const PUBLISH_KEY = 'traceability.coa_publish';
const DAY = 24 * 60 * 60 * 1000;
const today = () => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');

const certFields = (i: CertificateFields) => ({
  ...(i.certificateRef === undefined ? {} : { certificateRef: i.certificateRef }),
  ...(i.issuerName === undefined ? {} : { issuerName: i.issuerName }),
  ...(i.analystName === undefined ? {} : { analystName: i.analystName }),
  ...(i.signatoryName === undefined ? {} : { signatoryName: i.signatoryName }),
  ...(i.issuedAt === undefined ? {} : { issuedAt: toDate(i.issuedAt) }),
  ...(i.validUntil === undefined ? {} : { validUntil: toDate(i.validUntil) }),
});

/** A measured value as shown on the certificate ("10.2 %", "Conforms", "Pending review"). */
const shown = (r: { valueNum: number | null; valueText: string | null; unit: string | null }) =>
  r.valueText ??
  (r.valueNum === null
    ? 'Pending review'
    : `${String(r.valueNum)}${r.unit === null ? '' : ` ${r.unit}`}`);

type CoaRow = NonNullable<Awaited<ReturnType<CoasRepository['byId']>>>;

/**
 * Certificates of analysis (W16.05 review, W16.06 details, W16.10 auto-linking & validity).
 * Results are judged against the SKU spec at entry (snapshot kept per result); a DIFFERENT
 * person approves (four-eyes). Approving a failed independent COA recalls the batch in the
 * same transaction.
 */
export class CoasService {
  constructor(
    private readonly deps: {
      coasRepository: CoasRepository;
      runInTransaction: RunInTransaction;
      auditService: AuditService;
      mediaClient: MediaClient;
      projectionsService: ProjectionsService;
      samplesService: SamplesService;
      specsService: SpecsService;
      labsService: LabsService;
      releaseService: ReleaseService;
      certificatesService: CertificatesService;
    },
  ) {}

  private get repo() {
    return this.deps.coasRepository;
  }

  // ── W16.10 upload + auto-link ──

  async upload(caller: Caller, input: UploadInput) {
    const { runInTransaction, auditService, mediaClient, projectionsService, specsService } =
      this.deps;
    const doc = mediaClient.verify(input.receipt, caller.userId, 'body.receipt');
    const candidates = await projectionsService.findBatches(
      input.batchNo,
      input.variantId,
      input.cnNo,
    );
    const batch = candidates.length === 1 ? (candidates[0] ?? null) : null;
    if (!caller.access.isGlobal(PUBLISH_KEY)) {
      if (batch === null)
        throw new ValidationError([
          {
            path: 'body.batchNo',
            message: 'no single batch with this number was received at your warehouses',
          },
        ]);
      requireForBatch(
        caller,
        PUBLISH_KEY,
        await projectionsService.receivingWarehouses(batch.batchId),
      );
    }
    const spec = batch === null ? null : await specsService.policy(batch.variantId);
    const validityDays = spec?.coaValidityDays ?? null;
    const validUntil =
      input.validUntil === undefined && input.issuedAt !== undefined && validityDays !== null
        ? new Date(toDate(input.issuedAt).getTime() + validityDays * DAY)
        : undefined;
    const id = await runInTransaction(async (tx) => {
      const coa = await this.repo.create(tx, {
        coaNo: await nextNumber(tx, 'COA'),
        source: 'MANUFACTURER',
        batchId: batch?.batchId ?? null,
        variantId: batch?.variantId ?? input.variantId ?? null,
        batchNoOnDocument: input.batchNo,
        mediaKey: doc.key,
        status: batch === null ? 'UPLOADED' : 'LINKED',
        uploadedBy: caller.userId,
        ...certFields(input),
        ...(validUntil === undefined ? {} : { validUntil }),
      });
      await auditService.record(tx, actorOf(caller), {
        action: 'coa.uploaded',
        targetType: 'coa',
        targetId: coa.id,
        after: {
          coaNo: coa.coaNo,
          batchId: coa.batchId,
          batchNoOnDocument: input.batchNo,
          status: coa.status,
          candidates: candidates.length,
        },
      });
      return coa.id;
    });
    return this.get(caller, id);
  }

  /** "Confirm COA mapping": a person checks batch + QR and confirms (or picks the batch). */
  async confirmMapping(
    caller: Caller,
    id: string,
    input: { batchId?: string; expectedVersion: number },
  ) {
    const { runInTransaction, auditService, projectionsService } = this.deps;
    const coa = await this.mustSee(caller, id);
    if (
      coa.source !== 'MANUFACTURER' ||
      !['UPLOADED', 'LINKED', 'RESULTS_ENTERED'].includes(coa.status)
    )
      throw conflict('INVALID_TRANSITION', 'Only an open manufacturer COA can be mapped');
    const batchId = input.batchId ?? coa.batchId;
    if (batchId === null)
      throw new ValidationError([{ path: 'body.batchId', message: 'choose the batch' }]);
    const batch = await projectionsService.batch(batchId);
    if (batch === null) throw new NotFoundError('Batch');
    if (
      coa.batchNoOnDocument !== null &&
      batch.batchNo.toLowerCase() !== coa.batchNoOnDocument.toLowerCase()
    )
      throw conflict(
        'BATCH_MISMATCH',
        `The certificate is for batch ${coa.batchNoOnDocument}, not ${batch.batchNo}`,
      );
    if (coa.status === 'RESULTS_ENTERED' && coa.batchId !== batchId)
      throw conflict('INVALID_TRANSITION', 'Results were already entered for another batch');
    requireForBatch(caller, PUBLISH_KEY, await projectionsService.receivingWarehouses(batchId));
    await runInTransaction(async (tx) => {
      const ok = await this.repo.updateVersioned(
        tx,
        id,
        input.expectedVersion,
        ['UPLOADED', 'LINKED', 'RESULTS_ENTERED'],
        {
          batchId,
          variantId: batch.variantId,
          status: coa.status === 'UPLOADED' ? 'LINKED' : coa.status,
          mappingConfirmedBy: caller.userId,
          mappingConfirmedAt: new Date(),
        },
      );
      if (!ok) throw versionConflict(coa.version);
      await auditService.record(tx, actorOf(caller), {
        action: 'coa.mapping_confirmed',
        targetType: 'coa',
        targetId: id,
        before: { batchId: coa.batchId, status: coa.status },
        after: { batchId, batchNo: batch.batchNo },
      });
    });
    return this.get(caller, id);
  }

  // ── Results ──

  /** Manufacturer COA values (W16.05 "COA results — B2408"). */
  async enterResults(caller: Caller, id: string, input: ResultsInput) {
    const { runInTransaction, auditService, specsService, projectionsService } = this.deps;
    const coa = await this.mustSee(caller, id);
    if (coa.source !== 'MANUFACTURER')
      throw conflict(
        'INVALID_TRANSITION',
        'Enter independent results on the sample (PUT /samples/:id/results)',
      );
    if (coa.batchId === null || coa.variantId === null)
      throw conflict('NOT_LINKED', 'Link the certificate to a batch first (W16.10)');
    if (!['LINKED', 'RESULTS_ENTERED'].includes(coa.status))
      throw conflict('COA_CLOSED', `This certificate is ${coa.status.toLowerCase()}`);
    requireForBatch(caller, PUBLISH_KEY, await projectionsService.receivingWarehouses(coa.batchId));
    const spec = await specsService.activeSpec(coa.variantId);
    if (spec === null)
      throw conflict('SPEC_MISSING', 'Set the SKU specification limits first (W16.09)');
    const actor = actorOf(caller);
    await runInTransaction(async (tx) => {
      if (
        !(await this.repo.updateVersioned(
          tx,
          id,
          input.expectedVersion,
          ['LINKED', 'RESULTS_ENTERED'],
          certFields(input),
        ))
      )
        throw versionConflict(coa.version);
      const verdict = await this.writeResults(tx, id, spec.params, input.results, actor);
      await this.repo.update(tx, id, {
        status: 'RESULTS_ENTERED',
        verdict,
        specVersion: spec.version,
        enteredBy: caller.userId,
        enteredAt: new Date(),
      });
      await auditService.record(tx, actor, {
        action: 'coa.results_entered',
        targetType: 'coa',
        targetId: id,
        before: { status: coa.status, verdict: coa.verdict },
        after: {
          status: 'RESULTS_ENTERED',
          verdict,
          specVersion: spec.version,
          results: input.results,
        },
      });
    });
    return this.get(caller, id);
  }

  /** Independent lab results of a sample → its COA (created on first entry). */
  async sampleResults(caller: Caller, sampleId: string, input: SampleResultsInput) {
    const {
      runInTransaction,
      auditService,
      specsService,
      samplesService,
      mediaClient,
      labsService,
    } = this.deps;
    const sample = await samplesService.raw(sampleId);
    if (sample === null) throw new NotFoundError('Sample');
    requireAt(caller, PUBLISH_KEY, sample.warehouseId, 'Sample');
    const spec = await specsService.activeSpec(sample.variantId);
    if (spec === null)
      throw conflict('SPEC_MISSING', 'Set the SKU specification limits first (W16.09)');
    const doc =
      input.receipt === undefined
        ? null
        : mediaClient.verify(input.receipt, caller.userId, 'body.receipt');
    const lab = (await labsService.byIds([sample.labId])).get(sample.labId) ?? null;
    const actor = actorOf(caller);
    const coaId = await runInTransaction(async (tx) => {
      await samplesService.markResults(tx, actor, sampleId, input.expectedVersion);
      let coa = await this.repo.bySample(sampleId, tx);
      if (coa !== null && !['LINKED', 'RESULTS_ENTERED'].includes(coa.status))
        throw conflict(
          'COA_CLOSED',
          `The lab certificate of this sample is ${coa.status.toLowerCase()}`,
        );
      coa ??= await this.repo.create(tx, {
        coaNo: await nextNumber(tx, 'COA'),
        source: 'INDEPENDENT',
        batchId: sample.batchId,
        variantId: sample.variantId,
        labId: sample.labId,
        sampleId,
        issuerName: lab?.name ?? null,
        status: 'LINKED',
        uploadedBy: caller.userId,
      });
      const verdict = await this.writeResults(tx, coa.id, spec.params, input.results, actor);
      await this.repo.update(tx, coa.id, {
        ...certFields(input),
        ...(doc === null ? {} : { mediaKey: doc.key }),
        status: 'RESULTS_ENTERED',
        verdict,
        specVersion: spec.version,
        enteredBy: caller.userId,
        enteredAt: new Date(),
        version: { increment: 1 },
      });
      await auditService.record(tx, actor, {
        action: 'coa.results_entered',
        targetType: 'coa',
        targetId: coa.id,
        warehouseId: sample.warehouseId,
        before: { status: coa.status, verdict: coa.verdict },
        after: {
          status: 'RESULTS_ENTERED',
          verdict,
          sampleNo: sample.sampleNo,
          specVersion: spec.version,
          results: input.results,
        },
      });
      return coa.id;
    });
    return this.get(caller, coaId);
  }

  /**
   * One row per spec parameter (missing values → REVIEW "Pending review"), each with the limit
   * it was judged against. Unknown parameter codes are refused.
   */
  private async writeResults(
    tx: Tx,
    coaId: string,
    params: readonly SpecParam[],
    inputs: readonly ResultInput[],
    actor: Actor,
  ) {
    if (actor.userId === null) throw new Error('writeResults: results are entered by a person');
    const codes = new Set(params.map((p) => p.code));
    const seen = new Set<string>();
    const problems: { path: string; message: string }[] = [];
    inputs.forEach((r, i) => {
      const path = `body.results[${String(i)}].paramCode`;
      if (!codes.has(r.paramCode))
        problems.push({ path, message: `"${r.paramCode}" is not in the SKU specification` });
      if (seen.has(r.paramCode)) problems.push({ path, message: 'duplicate parameter' });
      seen.add(r.paramCode);
    });
    if (problems.length > 0) throw new ValidationError(problems);
    const byCode = new Map(inputs.map((r) => [r.paramCode, r]));
    const enteredBy = actor.userId;
    const rows = params.map((p) => {
      const m: Partial<ResultInput> = byCode.get(p.code) ?? {};
      const valueNum = m.valueNum ?? null;
      const valueText = m.valueText ?? null;
      return {
        coaId,
        paramCode: p.code,
        paramName: p.name,
        unit: p.unit,
        rule: p.rule,
        min: p.min,
        max: p.max,
        expectedText: p.expectedText,
        critical: p.critical,
        valueNum,
        valueText,
        verdict: judge(p, { valueNum, valueText }),
        sortOrder: p.sortOrder,
        enteredBy,
      };
    });
    await this.repo.replaceResults(tx, coaId, rows);
    return overallVerdict([...codes], rows);
  }

  // ── Review (four-eyes) ──

  async review(caller: Caller, id: string, input: ReviewInput) {
    const { runInTransaction, auditService, samplesService, releaseService } = this.deps;
    const coa = await this.mustSee(caller, id);
    if (coa.status !== 'RESULTS_ENTERED')
      throw conflict(
        'INVALID_TRANSITION',
        `Only entered results can be reviewed (this certificate is ${coa.status.toLowerCase()})`,
      );
    if (coa.enteredBy === caller.userId)
      throw conflict(
        'SAME_PERSON',
        'The person who entered the results cannot approve them; ask another QA approver',
      );
    if (input.decision === 'APPROVE' && coa.verdict === 'PENDING')
      throw conflict('RESULTS_INCOMPLETE', 'Some parameters still need a result', {
        params: await this.repo.paramNames(id, 'REVIEW'),
      });
    if (coa.batchId === null)
      throw conflict('NOT_LINKED', 'Link the certificate to a batch first (W16.10)');
    const batchId = coa.batchId;
    const actor = actorOf(caller);
    const approve = input.decision === 'APPROVE';
    const independent = coa.source === 'INDEPENDENT';
    const nextStatus = approve ? 'APPROVED' : independent ? 'LINKED' : 'REJECTED';
    await runInTransaction(async (tx) => {
      const now = new Date();
      const ok = await this.repo.updateVersioned(
        tx,
        id,
        input.expectedVersion,
        ['RESULTS_ENTERED'],
        {
          status: nextStatus,
          reviewedBy: caller.userId,
          reviewedAt: now,
          reviewNote: input.note,
          ...(approve && independent ? { publishedAt: now } : {}),
        },
      );
      if (!ok) throw versionConflict(coa.version);
      await auditService.record(tx, actor, {
        action: approve ? 'coa.approved' : 'coa.rejected',
        targetType: 'coa',
        targetId: id,
        before: { status: coa.status, verdict: coa.verdict, enteredBy: coa.enteredBy },
        after: { status: nextStatus, verdict: coa.verdict },
        reason: input.note,
      });
      if (independent && coa.sampleId !== null) {
        if (approve) {
          await samplesService.setOutcome(
            tx,
            actor,
            coa.sampleId,
            coa.verdict === 'PASS' ? 'PASSED' : 'FAILED',
            input.note,
          );
          await this.publish(tx, coa, batchId, caller.requestId);
          if (coa.verdict === 'FAIL') {
            const failed = await this.repo.paramNames(id, 'FAILS', tx);
            await releaseService.recallInTx(
              tx,
              actor,
              batchId,
              `Independent COA ${coa.coaNo} failed: ${failed.join(', ')}`.slice(0, 500),
              `auto-recall:${id}`,
              caller.requestId,
            );
          }
        } else {
          await samplesService.setOutcome(
            tx,
            actor,
            coa.sampleId,
            'TESTING',
            `Results sent back: ${input.note}`,
          );
        }
      }
      await releaseService.emitBatchState(tx, batchId, caller.requestId);
    });
    return this.get(caller, id);
  }

  /** `quality.coa_published.v1` → watchers ("Notify me when it's published"). */
  private async publish(tx: Tx, coa: CoaRow, batchId: string, correlationId: string) {
    const { projectionsService, certificatesService } = this.deps;
    const batch = await projectionsService.batch(batchId, tx);
    if (batch === null) return;
    const [variants, watchers, cnNos] = await Promise.all([
      projectionsService.variants([batch.variantId]),
      certificatesService.watcherIds(tx, batchId),
      projectionsService.cnNosOf(batchId, tx),
    ]);
    const variant = variants.get(batch.variantId);
    await emitQualityEvent(
      tx,
      'quality.coa_published.v1',
      {
        coaId: coa.id,
        coaNo: coa.coaNo,
        batchId,
        batchNo: batch.batchNo,
        variantId: batch.variantId,
        productName:
          variant === undefined ? batch.batchNo : `${variant.name} · ${variant.variantName}`,
        verdict: coa.verdict === 'FAIL' ? 'FAIL' : 'PASS',
        cnNos,
        watcherUserIds: watchers,
      },
      correlationId,
    );
  }

  // ── Reads ──

  async get(caller: Caller, id: string) {
    const { mediaClient, projectionsService, samplesService, labsService } = this.deps;
    const coa = await this.mustSee(caller, id);
    const [results, batch, sample, labs, units, other] = await Promise.all([
      this.repo.results(id),
      coa.batchId === null ? null : projectionsService.batch(coa.batchId),
      coa.sampleId === null ? null : samplesService.raw(coa.sampleId),
      labsService.byIds(coa.labId === null ? [] : [coa.labId]),
      coa.batchId === null ? 0 : projectionsService.unitsReceived(coa.batchId),
      coa.batchId === null
        ? null
        : this.repo.latestOf(
            coa.batchId,
            coa.source === 'MANUFACTURER' ? 'INDEPENDENT' : 'MANUFACTURER',
            ['RESULTS_ENTERED', 'APPROVED'],
          ),
    ]);
    const lab = coa.labId === null ? null : (labs.get(coa.labId) ?? null);
    const variantId = coa.variantId ?? batch?.variantId ?? null;
    const variant =
      variantId === null
        ? undefined
        : (await projectionsService.variants([variantId])).get(variantId);
    const urls = coa.mediaKey === null ? {} : await mediaClient.signRead([coa.mediaKey]);
    const mm =
      other === null
        ? null
        : coa.source === 'INDEPENDENT'
          ? mismatch(other.results, results)
          : mismatch(results, other.results);
    const candidates =
      coa.status === 'UPLOADED' && coa.batchNoOnDocument !== null
        ? (
            await projectionsService.findBatches(coa.batchNoOnDocument, coa.variantId ?? undefined)
          ).map((b) => ({ batchId: b.batchId, batchNo: b.batchNo }))
        : [];
    const count = (v: ParamVerdict) => results.filter((r) => r.verdict === v).length;
    return {
      id: coa.id,
      coaNo: coa.coaNo,
      source: coa.source,
      status: coa.status,
      verdict: coa.verdict,
      version: coa.version,
      certificateRef: coa.certificateRef,
      batchNoOnDocument: coa.batchNoOnDocument,
      batch:
        batch === null
          ? null
          : {
              batchId: batch.batchId,
              batchNo: batch.batchNo,
              mfgDate: ymd(batch.mfgDate),
              expiryDate: ymd(batch.expiryDate),
              serialized: batch.serialized,
            },
      product:
        variant === undefined
          ? null
          : {
              variantId: variant.variantId,
              sku: variant.sku,
              name: variant.name,
              variantName: variant.variantName,
              brandName: variant.brandName,
            },
      sample:
        sample === null
          ? null
          : {
              id: sample.id,
              sampleNo: sample.sampleNo,
              status: sample.status,
              labRef: sample.labRef,
            },
      lab: lab === null ? null : { id: lab.id, name: lab.name, accreditation: lab.accreditation },
      issuerName: coa.issuerName,
      analystName: coa.analystName,
      signatoryName: coa.signatoryName,
      issuedAt: ymd(coa.issuedAt),
      validUntil: ymd(coa.validUntil),
      validity: this.validity(coa),
      qrMapping:
        batch === null
          ? null
          : {
              serialized: batch.serialized,
              unitsReceived: units,
              text: batch.serialized
                ? `Unit QR codes of batch ${batch.batchNo} (${String(units)} units received)`
                : `Batch ${batch.batchNo} has no unit QR codes (batch-level stock)`,
            },
      mapping: {
        confirmed: coa.source === 'INDEPENDENT' || coa.mappingConfirmedAt !== null,
        confirmedBy: coa.mappingConfirmedBy,
        confirmedAt: coa.mappingConfirmedAt?.toISOString() ?? null,
        candidates,
      },
      document: coa.mediaKey === null ? null : { url: urls[coa.mediaKey] ?? null },
      results: results.map((r) => ({
        paramCode: r.paramCode,
        paramName: r.paramName,
        unit: r.unit,
        rule: r.rule,
        specLabel: specLabel(r),
        valueNum: r.valueNum,
        valueText: r.valueText,
        value: shown(r),
        verdict: r.verdict,
        critical: r.critical,
      })),
      summary: { conforms: count('CONFORMS'), fails: count('FAILS'), review: count('REVIEW') },
      entered: { by: coa.enteredBy, at: coa.enteredAt?.toISOString() ?? null },
      signature: {
        state: coa.status === 'APPROVED' ? 'SIGNED' : 'PENDING',
        reviewedBy: coa.reviewedBy,
        reviewedAt: coa.reviewedAt?.toISOString() ?? null,
        note: coa.reviewNote,
      },
      publishedAt: coa.publishedAt?.toISOString() ?? null,
      mismatch: mm,
      note: NOTE,
      actions: this.actions(coa, caller),
    };
  }

  async list(caller: Caller, q: CoaListQuery) {
    const { projectionsService } = this.deps;
    const scope = caller.access.scope('quality.view');
    const scopedBatchIds =
      scope === 'ALL' ? undefined : await projectionsService.batchIdsInWarehouses([...scope]);
    const term = q.q?.trim();
    const until =
      q.expiringWithinDays === undefined
        ? undefined
        : new Date(today().getTime() + q.expiringWithinDays * DAY);
    const rows = await this.repo.list(
      {
        ...(scopedBatchIds === undefined ? {} : { batchId: { in: scopedBatchIds } }),
        ...(q.batchId === undefined ? {} : { batchId: q.batchId }),
        ...(q.status === undefined ? {} : { status: q.status }),
        ...(q.source === undefined ? {} : { source: q.source }),
        ...(until === undefined ? {} : { status: 'APPROVED' as const, validUntil: { lte: until } }),
        ...(term === undefined || term === ''
          ? {}
          : {
              OR: [
                { coaNo: { contains: term, mode: 'insensitive' as const } },
                { batchNoOnDocument: { contains: term, mode: 'insensitive' as const } },
              ],
            }),
      },
      q.cursor,
      q.limit + 1,
    );
    const page = rows.slice(0, q.limit);
    const batches = await projectionsService.batches(
      page.flatMap((c) => (c.batchId === null ? [] : [c.batchId])),
    );
    return {
      items: page.map((c) => ({
        id: c.id,
        coaNo: c.coaNo,
        source: c.source,
        status: c.status,
        verdict: c.verdict,
        batchId: c.batchId,
        batchNo:
          (c.batchId === null ? undefined : batches.get(c.batchId)?.batchNo) ?? c.batchNoOnDocument,
        issuerName: c.issuerName,
        issuedAt: ymd(c.issuedAt),
        validUntil: ymd(c.validUntil),
        validity: this.validity(c),
        version: c.version,
      })),
      nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null,
      limit: q.limit,
    };
  }

  /** Job: approved certificates past valid-until → EXPIRED (+ batch read copy). */
  async expireDue(): Promise<number> {
    const { runInTransaction, auditService, releaseService } = this.deps;
    const due = await this.repo.dueToExpire(today());
    for (const c of due)
      await runInTransaction(async (tx) => {
        if (!(await this.repo.expire(tx, c.id))) return;
        await auditService.record(tx, SYSTEM, {
          action: 'coa.expired',
          targetType: 'coa',
          targetId: c.id,
          after: { coaNo: c.coaNo },
        });
        if (c.batchId !== null)
          await releaseService.emitBatchState(tx, c.batchId, 'job:coa-expiry');
      });
    return due.length;
  }

  // ── For other features ──

  /** Every COA of a batch, newest first (release checklist, certificate status). */
  async forBatch(batchId: string, tx?: Tx) {
    return this.repo.forBatch(batchId, tx);
  }

  /** Approved / entered COAs with results of batches (customer cards). */
  async withResults(batchIds: readonly string[]) {
    if (batchIds.length === 0) return [];
    return this.repo.withResults(batchIds, ['APPROVED', 'RESULTS_ENTERED', 'LINKED']);
  }

  /** The independent COA of a sample (W16.03), or null. */
  async summaryOfSample(sampleId: string) {
    const c = await this.repo.bySample(sampleId);
    return c === null ? null : { id: c.id, coaNo: c.coaNo, status: c.status, verdict: c.verdict };
  }

  // ── helpers ──

  private validity(c: { status: string; validUntil: Date | null }) {
    if (c.status === 'EXPIRED') return { state: 'EXPIRED', text: 'Certificate expired' };
    if (c.status !== 'APPROVED') return { state: 'PENDING_QA', text: 'Pending QA verification' };
    if (c.validUntil === null) return { state: 'VALID', text: 'Verify against approved policy' };
    const days = Math.floor((c.validUntil.getTime() - today().getTime()) / DAY);
    return days <= 30
      ? { state: 'EXPIRING', text: `Expires in ${String(days)} days` }
      : { state: 'VALID', text: `Valid until ${ymd(c.validUntil) ?? ''}` };
  }

  private actions(c: CoaRow, caller: Caller): string[] {
    const out: string[] = [];
    if (c.source === 'MANUFACTURER' && ['UPLOADED', 'LINKED', 'RESULTS_ENTERED'].includes(c.status))
      out.push('confirm-mapping');
    if (
      c.source === 'MANUFACTURER' &&
      ['LINKED', 'RESULTS_ENTERED'].includes(c.status) &&
      c.batchId !== null
    )
      out.push('enter-results');
    if (
      c.status === 'RESULTS_ENTERED' &&
      c.enteredBy !== caller.userId &&
      caller.access.isGlobal('traceability.coa_verify')
    )
      out.push('approve', 'reject');
    if (c.status === 'APPROVED' && c.batchId !== null) out.push('quality-release');
    return out;
  }

  /** A COA the caller may see: GLOBAL quality.view, or its batch was received in their scope. */
  private async mustSee(caller: Caller, id: string): Promise<CoaRow> {
    const coa = await this.repo.byId(id);
    if (coa === null) throw new NotFoundError('Certificate');
    if (caller.access.isGlobal('quality.view')) return coa;
    if (coa.batchId === null) throw new NotFoundError('Certificate');
    const whs = await this.deps.projectionsService.receivingWarehouses(coa.batchId);
    if (!whs.some((w) => caller.access.can('quality.view', w)))
      throw new NotFoundError('Certificate');
    return coa;
  }
}
