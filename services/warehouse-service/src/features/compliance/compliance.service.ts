import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { Caller } from '../../middleware/guards.js';
import { type Paging, csvCell, offsetOf } from '../../middleware/paging.js';
import type { CaseRow, CheckRow, JsonInput, RuleRow } from './compliance.repository.js';

type Status = CaseRow['status'];
type CheckType = CheckRow['type'];

const CHECK_LABEL: Record<CheckType, string> = {
  VET_RX: 'Veterinary prescription',
  DRUG_LICENCE: 'Drug licence (Form 20B / 21B)',
  RESTRICTED_PERMIT: 'Restricted product permit',
  FARMER_DECLARATION: 'Farmer declaration',
  COA: 'Certificate of analysis',
};
const OPEN: readonly Status[] = ['PENDING', 'FLAGGED', 'ON_HOLD'];

interface AppliesWhen {
  drugSchedules?: string[];
  antimicrobial?: boolean;
  vetConsult?: boolean;
  hazardous?: boolean;
  hazardClasses?: string[];
}

/** Which registry rules a SKU triggers (pure). */
export const matchRules = (
  rules: readonly RuleRow[],
  v: {
    drugSchedule: string | null;
    isAntimicrobial: boolean;
    isPrescriptionRequired: boolean;
    hazardClass: string | null;
  },
): RuleRow[] =>
  rules.filter((r) => {
    if (!r.isActive) return false;
    const w = r.appliesWhen as AppliesWhen;
    return (
      (w.drugSchedules !== undefined &&
        v.drugSchedule !== null &&
        w.drugSchedules.includes(v.drugSchedule)) ||
      (w.antimicrobial === true && v.isAntimicrobial) ||
      (w.vetConsult === true && v.isPrescriptionRequired) ||
      (w.hazardous === true && v.hazardClass !== null) ||
      (w.hazardClasses !== undefined &&
        v.hazardClass !== null &&
        w.hazardClasses.includes(v.hazardClass))
    );
  });

/**
 * Compliance gate (W3.16, §2a.7). An order with regulated lines gets a case with mandatory checks
 * (from the registry); FEFO allocation waits until it is APPROVED. Checks are verified by a
 * `compliance.review` holder other than the uploader; a waiver needs step-up TOTP. Overdue cases
 * escalate twice and are auto-REJECTED at the limit (never auto-approved).
 */
export class ComplianceService {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'complianceRepository'
      | 'stockService'
      | 'fulfilmentSettings'
      | 'fulfilmentOrders'
      | 'fulfilmentQueries'
      | 'fulfilmentSync'
      | 'calendarService'
      | 'orderClient'
      | 'authClient'
      | 'mediaClient'
      | 'storageService'
      | 'runInTransaction'
      | 'auditService'
      | 'logger'
    >,
  ) {}

  private get repo() {
    return this.deps.complianceRepository;
  }

  // ── system (inbox / jobs) ──

  /** Creates the case when an order has regulated lines; returns the order's compliance status. */
  async evaluateInTx(
    tx: Tx,
    o: {
      orderId: string;
      orderNo: string;
      warehouseId: string | null;
      lines: readonly { lineNo: number; variantId: string; qty: number }[];
      value: string;
    },
  ): Promise<Status> {
    const existing = await this.repo.byOrder(o.orderId, tx);
    if (existing !== null) return existing.status;
    const [rules, variants, settings] = await Promise.all([
      this.repo.rules(tx),
      this.deps.stockService.variantRows(
        o.lines.map((l) => l.variantId),
        tx,
      ),
      this.deps.fulfilmentSettings.all(o.warehouseId ?? 'GLOBAL'),
    ]);
    const checks = new Map<
      CheckType,
      { lineNos: number[]; ruleKey: string; legalBasis: string | null; qty: number }
    >();
    let restricted = 0;
    for (const l of o.lines) {
      const v = variants.find((x) => x.variantId === l.variantId);
      if (v === undefined) continue;
      const hit = matchRules(rules, v);
      if (hit.length === 0) continue;
      restricted += 1;
      for (const r of hit)
        for (const t of r.requiredChecks) {
          const c = checks.get(t) ?? {
            lineNos: [],
            ruleKey: r.key,
            legalBasis: r.legalBasis,
            qty: 0,
          };
          if (!c.lineNos.includes(l.lineNo)) c.lineNos.push(l.lineNo);
          c.qty += l.qty;
          checks.set(t, c);
        }
    }
    if (checks.size === 0) return 'NOT_REQUIRED';
    await this.repo.create(
      tx,
      {
        caseNo: await this.deps.stockService.nextDocNo(tx, 'CMP'),
        orderId: o.orderId,
        warehouseId: o.warehouseId,
        status: 'PENDING',
        slaDueAt: new Date(Date.now() + settings['fulfilment.complianceSlaHours'] * 3_600_000),
        restrictedCount: restricted,
        skuCount: o.lines.length,
        value: o.value,
      },
      [...checks].map(([type, c]) => ({
        type,
        ruleKey: c.ruleKey,
        lineNos: c.lineNos,
        legalBasis: c.legalBasis,
        qtyLabel: `${String(c.qty)} units`,
      })),
    );
    return 'PENDING';
  }

  /** Order closed elsewhere: an open case is closed with it. */
  async closeForOrderInTx(tx: Tx, orderId: string, why: string) {
    const c = await this.repo.byOrder(orderId, tx);
    if (c === null || !OPEN.includes(c.status)) return;
    await this.repo.update(tx, c.id, {
      status: 'REJECTED',
      decidedAt: new Date(),
      decisionNote: `Order ${why.toLowerCase()}`,
    });
  }

  /** compliance-escalation job (every 15 min). */
  async escalate() {
    const due = await this.repo.dueForEscalation(new Date(), 200);
    let flagged = 0;
    let level2 = 0;
    let rejected = 0;
    for (const { id } of due) {
      const c = await this.repo.case(id);
      if (c === null || !OPEN.includes(c.status)) continue;
      const s = await this.deps.fulfilmentSettings.all(c.warehouseId ?? 'GLOBAL');
      const age = (Date.now() - c.createdAt.getTime()) / 3_600_000;
      if (age >= s['fulfilment.complianceAutoRejectHours']) {
        try {
          await this.deps.orderClient.complianceReject(
            c.orderId,
            'Compliance documents not verified in time',
          );
          await this.deps.runInTransaction(async (tx) => {
            await this.repo.update(tx, c.id, {
              status: 'REJECTED',
              decidedAt: new Date(),
              decisionNote: 'Auto-rejected: time limit passed',
            });
            await this.deps.fulfilmentSync.setComplianceStatus(tx, c.orderId, 'REJECTED');
          });
          rejected += 1;
        } catch (err) {
          this.deps.logger.warn(
            { err, caseId: c.id },
            'compliance auto-reject failed; retry next run',
          );
        }
        continue;
      }
      const overdueH = (Date.now() - c.slaDueAt.getTime()) / 3_600_000;
      const level = overdueH >= 24 ? 2 : 1;
      if (level > c.escalationLevel || c.status === 'PENDING')
        await this.deps.runInTransaction(async (tx) => {
          await this.repo.update(tx, c.id, {
            status: c.status === 'ON_HOLD' ? 'ON_HOLD' : 'FLAGGED',
            escalationLevel: Math.max(level, c.escalationLevel),
          });
        });
      if (level === 2 && c.escalationLevel < 2) level2 += 1;
      else if (c.escalationLevel < 1) flagged += 1;
    }
    return { checked: due.length, flagged, level2, rejected };
  }

  // ── W3.16 reads ──

  async kpis(caller: Caller, warehouseId?: string) {
    const scope = this.scope(caller, warehouseId);
    const [counts, avg] = await Promise.all([
      this.repo.statusCounts(scope, warehouseId),
      this.repo.avgDecisionMinutes(scope, new Date(Date.now() - 30 * 86_400_000), warehouseId),
    ]);
    const n = (s: Status) => counts[s] ?? 0;
    return {
      tabs: [
        { key: 'PENDING', label: 'Pending', count: n('PENDING') + n('FLAGGED') },
        { key: 'FLAGGED', label: 'Flagged', count: n('FLAGGED') },
        { key: 'ON_HOLD', label: 'On hold', count: n('ON_HOLD') },
        { key: 'APPROVED', label: 'Approved', count: n('APPROVED') },
        { key: 'REJECTED', label: 'Rejected', count: n('REJECTED') },
      ],
      autoAuditAvgMinutes: avg,
      statePortalSync: null,
      modules: { statePortal: false, ocr: false, whatsapp: false },
      asOf: new Date().toISOString(),
    };
  }

  async cases(caller: Caller, f: { status?: string; q?: string; warehouseId?: string }, p: Paging) {
    const scope = this.scope(caller, f.warehouseId);
    const offset = offsetOf(p);
    const statusFilter = f.status === 'PENDING' ? undefined : f.status;
    const rows = await this.repo.cases(
      scope,
      { ...f, ...(statusFilter === undefined ? {} : { status: statusFilter }) },
      { limit: p.limit, offset, ...(p.cursor === undefined ? {} : { cursor: p.cursor }) },
    );
    const filtered =
      f.status === 'PENDING'
        ? rows.filter((r) => r.status === 'PENDING' || r.status === 'FLAGGED')
        : rows;
    const items = filtered.slice(0, p.limit);
    const total =
      offset === null
        ? undefined
        : await this.repo.countCases(scope, {
            ...f,
            ...(statusFilter === undefined ? {} : { status: statusFilter }),
          });
    const views = await Promise.all(items.map((c) => this.card(caller, c)));
    return {
      items: views,
      nextCursor: offset === null && filtered.length > p.limit ? (items.at(-1)?.id ?? null) : null,
      limit: p.limit,
      ...(p.page === undefined ? {} : { page: p.page }),
      ...(total === undefined
        ? {}
        : { total: Math.min(total, 10_000), totalIsEstimate: total > 10_000 }),
    };
  }

  async case(caller: Caller, id: string) {
    const c = await this.visible(caller, id);
    const [{ order }, settings, notes, evidence, waivers, inspector] = await Promise.all([
      this.deps.fulfilmentOrders.visible(caller, c.orderId),
      this.deps.fulfilmentSettings.all(c.warehouseId ?? 'GLOBAL'),
      this.repo.notes(c.id),
      this.repo.evidence(c.id),
      this.repo.waivers(c.id),
      c.inspectorUserId === null ? Promise.resolve(null) : this.repo.inspector(c.inspectorUserId),
    ]);
    const cal =
      c.warehouseId === null ? null : await this.deps.calendarService.slaCalendar(c.warehouseId);
    const urls = await this.deps.mediaClient.signRead(c.checks.flatMap((x) => x.mediaKeys));
    return {
      ...(await this.card(caller, c)),
      gateLabel: settings['fulfilment.complianceGateLabel'],
      guidelinesUrl: settings['fulfilment.complianceGuidelinesUrl'],
      customerAccountCode: order.farmCode,
      dispatchCutoff: cal?.cutoff ?? null,
      checklist: c.checks.map((x) => ({
        id: x.id,
        type: x.type,
        label: CHECK_LABEL[x.type],
        ruleKey: x.ruleKey,
        lineNos: x.lineNos,
        status: x.status,
        legalBasis: x.legalBasis,
        documentNo: x.documentNo,
        issuerName: x.issuerName,
        issuerRegNo: x.issuerRegNo,
        validUntil: x.validUntil?.toISOString().slice(0, 10) ?? null,
        verificationMethod: x.verificationMethod,
        qtyLabel: x.qtyLabel,
        documents: x.mediaKeys.map((k) => ({ key: k, url: urls[k] ?? null })),
        uploadedBy: x.uploadedBy,
        verifiedBy: x.verifiedBy,
        verifiedAt: x.verifiedAt,
        note: x.note,
        requestedAt: x.requestedAt,
        requestedVia: x.requestedVia,
      })),
      inspector: inspector ?? (c.inspectorUserId === null ? null : { userId: c.inspectorUserId }),
      notes,
      evidence,
      waivers,
      decision: {
        canApprove:
          c.checks.every((x) => x.status === 'VERIFIED' || x.status === 'WAIVED') &&
          OPEN.includes(c.status),
        decidedBy: c.decidedBy,
        decidedAt: c.decidedAt,
        note: c.decisionNote,
      },
      version: c.version,
    };
  }

  /** Restricted lines with the proposed FEFO lot, plus the customer's period totals. */
  async restrictedLedger(caller: Caller, id: string) {
    const c = await this.visible(caller, id);
    const { order, shipments } = await this.deps.fulfilmentOrders.visible(caller, c.orderId);
    const lineNos = new Set(c.checks.flatMap((x) => x.lineNos));
    const lines = order.lines.filter((l) => lineNos.has(l.lineNo));
    const variants = new Map(
      (await this.deps.stockService.variantRows(lines.map((l) => l.variantId))).map((v) => [
        v.variantId,
        v,
      ]),
    );
    const wh = c.warehouseId ?? shipments[0]?.warehouseId ?? null;
    const lots =
      wh === null
        ? []
        : await this.deps.stockService.lotsFor(
            wh,
            lines.map((l) => l.variantId),
          );
    const bins = await this.deps.storageService.binLocations(
      lots.flatMap((x) => (x.binId === null ? [] : [x.binId])),
    );
    const period =
      order.userId === null
        ? []
        : await this.deps.fulfilmentQueries.customerPeriodQty(
            order.userId,
            lines.map((l) => l.variantId),
            new Date(Date.now() - 30 * 86_400_000),
          );
    return {
      caseId: c.id,
      lines: lines.map((l) => {
        const v = variants.get(l.variantId);
        // FEFO lot, preferring a secure (vault) zone for restricted SKUs.
        const candidates = lots.filter((x) => x.variantId === l.variantId && x.binId !== null);
        const secure = candidates.find(
          (x) => x.binId !== null && bins.get(x.binId)?.isSecure === true,
        );
        const lot = secure ?? candidates[0];
        const zone = lot?.binId == null ? undefined : bins.get(lot.binId);
        return {
          lineNo: l.lineNo,
          variantId: l.variantId,
          sku: l.sku ?? v?.sku ?? null,
          name: l.name ?? v?.name ?? null,
          drugSchedule: v?.drugSchedule ?? null,
          antimicrobial: v?.isAntimicrobial ?? false,
          hazardClass: v?.hazardClass ?? null,
          qty: l.qty - l.cancelledQty,
          proposedLot:
            lot === undefined
              ? null
              : {
                  batchNo: lot.batchNo,
                  expiryDate: lot.expiryDate?.toISOString().slice(0, 10) ?? null,
                  positionId: lot.positionId,
                  bin: zone?.binCode ?? null,
                },
          secureZone: zone?.isSecure === true ? zone.zoneName : null,
          status: c.checks
            .filter((x) => x.lineNos.includes(l.lineNo))
            .every((x) => x.status === 'VERIFIED' || x.status === 'WAIVED')
            ? 'CLEARED'
            : 'PENDING',
          customerPeriod: period.find((p) => p.variantId === l.variantId) ?? { qty: 0, orders: 0 },
        };
      }),
      periodDays: 30,
      modules: { secureZones: true },
    };
  }

  // ── W3.16 commands ──

  /** Attach a document to a check (media receipt from media-service, purpose wms_document). */
  async addDocument(
    caller: Caller,
    id: string,
    input: {
      checkId: string;
      receipt: string;
      documentNo?: string | null;
      issuerName?: string | null;
      issuerRegNo?: string | null;
      validUntil?: string | null;
      note?: string | null;
    },
  ) {
    const file = this.deps.mediaClient.verify(
      input.receipt,
      caller.userId,
      'body.receipt',
      'wms_document',
    );
    await this.deps.runInTransaction(async (tx) => {
      const c = await this.lockOpen(tx, caller, id, 'fulfilment.manage');
      const chk = c.checks.find((x) => x.id === input.checkId);
      if (chk === undefined) throw new NotFoundError('Check');
      await this.repo.updateCheck(tx, chk.id, {
        mediaKeys: [...chk.mediaKeys, file.key],
        uploadedBy: caller.userId,
        verificationMethod: 'MANUAL',
        ...(input.documentNo === undefined ? {} : { documentNo: input.documentNo }),
        ...(input.issuerName === undefined ? {} : { issuerName: input.issuerName }),
        ...(input.issuerRegNo === undefined ? {} : { issuerRegNo: input.issuerRegNo }),
        ...(input.validUntil === undefined
          ? {}
          : {
              validUntil:
                input.validUntil === null ? null : new Date(`${input.validUntil}T00:00:00.000Z`),
            }),
        ...(chk.status === 'REJECTED' ? { status: 'PENDING' } : {}),
      });
      await this.repo.addEvidence(tx, {
        caseId: c.id,
        checkId: chk.id,
        docType:
          chk.type === 'VET_RX'
            ? 'RX_SCAN'
            : chk.type === 'FARMER_DECLARATION'
              ? 'DECLARATION'
              : chk.type === 'DRUG_LICENCE' || chk.type === 'RESTRICTED_PERMIT'
                ? 'LICENCE'
                : 'OTHER',
        mediaKey: file.key,
        note: input.note ?? null,
        uploadedBy: caller.userId,
      });
      await this.audit(tx, caller, 'compliance.document_added', c.id, {
        checkId: chk.id,
        type: chk.type,
      });
    });
    return this.case(caller, id);
  }

  /** Extra evidence (scan slip, declaration) not tied to one check. */
  async addEvidence(
    caller: Caller,
    id: string,
    input: {
      docType: 'RX_SCAN' | 'LICENCE' | 'DECLARATION' | 'OTHER';
      receipt: string;
      checkId?: string | null;
      note?: string | null;
    },
  ) {
    const file = this.deps.mediaClient.verify(
      input.receipt,
      caller.userId,
      'body.receipt',
      'wms_document',
    );
    await this.deps.runInTransaction(async (tx) => {
      const c = await this.lockOpen(tx, caller, id, 'fulfilment.manage');
      await this.repo.addEvidence(tx, {
        caseId: c.id,
        checkId: input.checkId ?? null,
        docType: input.docType,
        mediaKey: file.key,
        note: input.note ?? null,
        uploadedBy: caller.userId,
      });
      await this.audit(tx, caller, 'compliance.evidence_added', c.id, { docType: input.docType });
    });
    return this.evidence(caller, id);
  }

  async evidence(caller: Caller, id: string) {
    const c = await this.visible(caller, id);
    const rows = await this.repo.evidence(c.id);
    const urls = await this.deps.mediaClient.signRead(rows.map((r) => r.mediaKey));
    return rows.map((r) => ({ ...r, url: urls[r.mediaKey] ?? null }));
  }

  /** Verify / reject one check: GLOBAL compliance.review, never the uploader. */
  async decideCheck(
    caller: Caller,
    id: string,
    checkId: string,
    input: { decision: 'VERIFIED' | 'REJECTED'; note?: string | null },
  ) {
    this.requireReviewer(caller);
    await this.deps.runInTransaction(async (tx) => {
      const c = await this.lockOpen(tx, caller, id, 'fulfilment.view');
      const chk = c.checks.find((x) => x.id === checkId);
      if (chk === undefined) throw new NotFoundError('Check');
      if (chk.uploadedBy === caller.userId)
        throw new ForbiddenError(
          'Another person must verify the document you uploaded (segregation of duties)',
        );
      if (input.decision === 'VERIFIED' && chk.mediaKeys.length === 0 && chk.type !== 'COA')
        throw new ConflictError('Attach the document first', {
          details: { reason: 'DOCUMENT_MISSING' },
        });
      if (input.decision === 'REJECTED' && (input.note ?? '').trim().length < 5)
        throw new ValidationError([{ path: 'body.note', message: 'a reason is required' }]);
      await this.repo.updateCheck(tx, chk.id, {
        status: input.decision,
        verifiedBy: caller.userId,
        verifiedAt: new Date(),
        note: input.note ?? null,
      });
      await this.audit(
        tx,
        caller,
        'compliance.check_decided',
        c.id,
        { checkId, decision: input.decision },
        input.note ?? null,
      );
    });
    return this.case(caller, id);
  }

  async setInspector(caller: Caller, id: string, input: { inspectorUserId: string | null }) {
    await this.deps.runInTransaction(async (tx) => {
      const c = await this.lockOpen(tx, caller, id, 'fulfilment.manage');
      await this.repo.update(tx, c.id, { inspectorUserId: input.inspectorUserId });
      await this.audit(tx, caller, 'compliance.inspector_set', c.id, input);
    });
    return this.case(caller, id);
  }

  async addNote(caller: Caller, id: string, body: string) {
    await this.deps.runInTransaction(async (tx) => {
      const c = await this.lockAny(tx, caller, id, 'fulfilment.view');
      await this.repo.addNote(tx, { caseId: c.id, body, authorId: caller.userId });
    });
    return this.repo.notes(id);
  }

  /** Ask the customer for a document (SMS / in-app today; WhatsApp when integrated). */
  async requestDocument(
    caller: Caller,
    id: string,
    checkId: string,
    input: { channel: 'SMS' | 'IN_APP' | 'WHATSAPP' },
  ) {
    const via = input.channel === 'WHATSAPP' ? 'SMS' : input.channel;
    await this.deps.runInTransaction(async (tx) => {
      const c = await this.lockOpen(tx, caller, id, 'fulfilment.manage');
      const chk = c.checks.find((x) => x.id === checkId);
      if (chk === undefined) throw new NotFoundError('Check');
      await this.repo.updateCheck(tx, chk.id, { requestedAt: new Date(), requestedVia: via });
      await this.audit(tx, caller, 'compliance.document_requested', c.id, {
        checkId,
        channel: input.channel,
        via,
      });
    });
    return { requested: true, deliveredVia: via, modules: { whatsapp: false } };
  }

  /**
   * Approve & release / Hold / Reject. Approve needs every check verified or waived. Reject asks
   * order-service (REJECTED before admin confirmation, cancel + refund after); its stock release
   * then frees the lots here.
   */
  async decide(
    caller: Caller,
    id: string,
    input: {
      decision: 'APPROVE' | 'HOLD' | 'REJECT';
      note?: string | null;
      expectedVersion: number;
    },
  ) {
    this.requireReviewer(caller);
    const c = await this.visible(caller, id);
    if (c.version !== input.expectedVersion)
      throw new ConflictError('The case changed', { details: { reason: 'VERSION_CONFLICT' } });
    if (!OPEN.includes(c.status))
      throw new ConflictError(`The case is ${c.status}`, { details: { reason: 'INVALID_STATE' } });
    if (input.decision === 'REJECT') {
      if ((input.note ?? '').trim().length < 5)
        throw new ValidationError([{ path: 'body.note', message: 'a reason is required' }]);
      if (c.checks.some((x) => x.uploadedBy === caller.userId))
        throw new ForbiddenError(
          'You uploaded documents on this case; another reviewer must reject it',
        );
      await this.deps.orderClient.complianceReject(c.orderId, input.note ?? 'Compliance rejected');
    }
    if (
      input.decision === 'APPROVE' &&
      !c.checks.every((x) => x.status === 'VERIFIED' || x.status === 'WAIVED')
    )
      throw new ConflictError('Every mandatory check must be verified or waived', {
        details: { reason: 'CHECKS_PENDING' },
      });
    const to: Status =
      input.decision === 'APPROVE'
        ? 'APPROVED'
        : input.decision === 'HOLD'
          ? 'ON_HOLD'
          : 'REJECTED';
    await this.deps.runInTransaction(async (tx) => {
      await this.repo.update(tx, c.id, {
        status: to,
        ...(to === 'ON_HOLD' ? {} : { decidedBy: caller.userId, decidedAt: new Date() }),
        decisionNote: input.note ?? null,
      });
      await this.deps.fulfilmentSync.setComplianceStatus(tx, c.orderId, to);
      await this.audit(
        tx,
        caller,
        `compliance.${input.decision.toLowerCase()}`,
        c.id,
        { orderId: c.orderId, to },
        input.note ?? null,
      );
    });
    return this.case(caller, id);
  }

  /** Form 19 waiver: GLOBAL compliance.review + the reviewer's current TOTP code (step-up). */
  async waiver(
    caller: Caller,
    id: string,
    input: {
      authorizationNo: string;
      receipt?: string | null;
      totpCode: string;
      checkIds?: string[];
      note?: string | null;
    },
  ) {
    this.requireReviewer(caller);
    const step = await this.deps.authClient.verifyStepUp(caller.userId, input.totpCode);
    if (step.locked)
      throw new ConflictError('Too many wrong codes; try again in 15 minutes', {
        details: { reason: 'STEP_UP_LOCKED' },
      });
    if (!step.valid)
      throw new ValidationError([{ path: 'body.totpCode', message: 'is not valid' }]);
    const file =
      input.receipt === undefined || input.receipt === null
        ? null
        : this.deps.mediaClient.verify(
            input.receipt,
            caller.userId,
            'body.receipt',
            'wms_document',
          );
    await this.deps.runInTransaction(async (tx) => {
      const c = await this.lockOpen(tx, caller, id, 'fulfilment.view');
      const targets = c.checks.filter(
        (x) =>
          (input.checkIds === undefined || input.checkIds.includes(x.id)) &&
          x.status !== 'VERIFIED',
      );
      for (const x of targets)
        await this.repo.updateCheck(tx, x.id, {
          status: 'WAIVED',
          verifiedBy: caller.userId,
          verifiedAt: new Date(),
          note: `Waiver ${input.authorizationNo}`,
        });
      await this.repo.addWaiver(tx, {
        caseId: c.id,
        authorizationNo: input.authorizationNo,
        receipt: file?.key ?? null,
        checkIds: targets.map((x) => x.id),
        waivedBy: caller.userId,
      });
      await this.audit(
        tx,
        caller,
        'compliance.waiver',
        c.id,
        { authorizationNo: input.authorizationNo, checks: targets.map((x) => x.type) },
        input.note ?? null,
      );
    });
    return this.case(caller, id);
  }

  // ── registry + inspectors (admin) ──

  registry() {
    return this.repo.rules();
  }

  async putRule(
    caller: Caller,
    key: string,
    input: {
      name: string;
      appliesWhen: AppliesWhen;
      requiredChecks: CheckType[];
      legalBasis?: string | null;
      periodLimitQty?: number | null;
      isActive?: boolean;
    },
  ) {
    return this.deps.runInTransaction(async (tx) => {
      const r = await this.repo.upsertRule(tx, key, {
        name: input.name,
        appliesWhen: input.appliesWhen as JsonInput,
        requiredChecks: input.requiredChecks,
        legalBasis: input.legalBasis ?? null,
        periodLimitQty: input.periodLimitQty ?? null,
        isActive: input.isActive ?? true,
        updatedBy: caller.userId,
      });
      await this.audit(tx, caller, 'compliance.rule_saved', key, input);
      return r;
    });
  }

  inspectors() {
    return this.repo.inspectors();
  }

  async putInspector(
    caller: Caller,
    userId: string,
    input: {
      displayName: string;
      title?: string | null;
      govtRegNo?: string | null;
      photoReceipt?: string | null;
      onDuty?: boolean;
    },
  ) {
    const photo =
      input.photoReceipt === undefined || input.photoReceipt === null
        ? undefined
        : this.deps.mediaClient.verify(
            input.photoReceipt,
            caller.userId,
            'body.photoReceipt',
            'wms_document',
          ).key;
    return this.deps.runInTransaction(async (tx) => {
      const r = await this.repo.upsertInspector(tx, userId, {
        displayName: input.displayName,
        title: input.title ?? null,
        govtRegNo: input.govtRegNo ?? null,
        ...(photo === undefined ? {} : { photoMediaKey: photo }),
        onDuty: input.onDuty ?? true,
      });
      await this.audit(tx, caller, 'compliance.inspector_saved', userId, {
        displayName: input.displayName,
      });
      return r;
    });
  }

  async *auditCsv(caller: Caller, f: { status?: string; warehouseId?: string }) {
    yield 'Case,Order,Status,Restricted lines,SKUs,Value,SLA due,Escalation,Decided at,Decided by,Note\n';
    let cursor: string | undefined;
    for (;;) {
      const page = await this.cases(caller, f, {
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const c of page.items)
        yield `${[
          c.caseNo,
          c.orderNo,
          c.status,
          c.restrictedCount,
          c.skuCount,
          c.value,
          c.slaDueAt,
          c.escalationLevel,
          c.decidedAt,
          c.decidedBy,
          c.decisionNote,
        ]
          .map((v) => csvCell(v))
          .join(',')}\n`;
      if (page.nextCursor === null) return;
      cursor = page.nextCursor;
    }
  }

  // ── helpers ──

  private async card(caller: Caller, c: CaseRow) {
    const { order } = await this.deps.fulfilmentOrders.visible(caller, c.orderId);
    const chip = c.checks.some((x) => x.validUntil !== null && x.validUntil.getTime() < Date.now())
      ? 'PERMIT EXPIRED'
      : c.checks.filter((x) => x.type === 'VET_RX').every((x) => x.status === 'VERIFIED') &&
          c.checks.some((x) => x.type === 'VET_RX')
        ? 'RX VERIFIED'
        : 'ACTIVE CHECK';
    return {
      id: c.id,
      caseNo: c.caseNo,
      orderId: c.orderId,
      orderNo: order.orderNo,
      customer: order.farmName ?? order.customerName,
      status: c.status,
      chip,
      skuLabel: `${String(c.skuCount)} SKUs (${String(c.restrictedCount)} Restricted)`,
      skuCount: c.skuCount,
      restrictedCount: c.restrictedCount,
      value: c.value.toFixed(2),
      slaDueAt: c.slaDueAt,
      overdue: c.slaDueAt.getTime() < Date.now() && OPEN.includes(c.status),
      escalationLevel: c.escalationLevel,
      checksDone: c.checks.filter((x) => x.status === 'VERIFIED' || x.status === 'WAIVED').length,
      checksTotal: c.checks.length,
      decidedAt: c.decidedAt,
      decidedBy: c.decidedBy,
      decisionNote: c.decisionNote,
      createdAt: c.createdAt,
    };
  }

  private requireReviewer(caller: Caller) {
    if (!caller.access.isGlobal('compliance.review'))
      throw new ForbiddenError('Compliance decisions need the GLOBAL compliance review permission');
  }

  private scope(caller: Caller, warehouseId?: string) {
    if (warehouseId !== undefined) caller.access.require('fulfilment.view', warehouseId);
    return caller.access.scope('fulfilment.view');
  }

  private async visible(caller: Caller, id: string): Promise<CaseRow> {
    const c = await this.repo.case(id);
    if (c === null) throw new NotFoundError('Compliance case');
    if (c.warehouseId !== null) caller.access.require('fulfilment.view', c.warehouseId);
    else if (caller.access.scope('fulfilment.view') !== 'ALL')
      throw new NotFoundError('Compliance case');
    return c;
  }

  private async lockAny(tx: Tx, caller: Caller, id: string, key: string) {
    const c = await this.repo.lock(tx, id);
    if (c === null) throw new NotFoundError('Compliance case');
    if (c.warehouseId !== null) caller.access.require(key, c.warehouseId);
    else if (caller.access.scope(key) !== 'ALL') throw new NotFoundError('Compliance case');
    return c;
  }

  private async lockOpen(tx: Tx, caller: Caller, id: string, key: string) {
    const c = await this.lockAny(tx, caller, id, key);
    if (!OPEN.includes(c.status))
      throw new ConflictError(`The case is ${c.status}`, { details: { reason: 'INVALID_STATE' } });
    return c;
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
      {
        action,
        targetType: 'compliance_case',
        targetId: id,
        after: after as Record<string, unknown>,
        reason,
      },
    );
  }
}
