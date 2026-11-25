import { ForbiddenError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Cradle } from '@fastify/awilix';

import type { Caller } from '../../middleware/guards.js';
import { num } from '../../middleware/http.js';
import { type Paging, decodeCursor, toPageResult } from '../../middleware/paging.js';
import { dayBounds } from '../../middleware/time.js';
import type { CheckRow, OutwardRow, VisitorRow } from './gate.registers.repository.js';
import { formatMobile, formatRegNo, maskMobile, normalizeRegNo } from './gate.rules.js';
import { conflict } from './gate.support.js';

export interface VisitorInput {
  warehouseId: string;
  name: string;
  mobile?: string | null;
  company?: string | null;
  purpose: string;
  hostLabel?: string | null;
  hostUserId?: string | null;
  gateEntryId?: string | null;
  checkIn?: boolean;
}

export interface OutwardInput {
  warehouseId: string;
  material: string;
  qty: number;
  unit: string;
  vehicleRegNo?: string | null;
  receiver?: string | null;
  remarks?: string | null;
}

export interface CheckInput {
  warehouseId: string;
  subjectType: 'ENTRY' | 'VISITOR' | 'OUTWARD';
  subjectId: string;
  identityCheck?: 'PASS' | 'FAIL' | 'NA';
  plateCheck?: 'PASS' | 'FAIL' | 'NA';
  outwardCheck?: 'PASS' | 'FAIL' | 'NA';
  remarks?: string | null;
}

const VISITOR_LABEL: Record<string, string> = {
  PENDING: 'Pending',
  ON_SITE: 'On site',
  CHECKED_OUT: 'Checked out',
  DENIED: 'Denied',
};
const OUTWARD_LABEL: Record<string, string> = {
  PENDING_AUTH: 'Pending authorization',
  AUTHORIZED: 'Authorized',
  EXITED: 'Exited',
  REJECTED: 'Rejected',
};
const CHECK_TEXT = {
  identityCheck: { PASS: 'Identity verified', FAIL: 'Identity not verified', NA: null },
  plateCheck: { PASS: 'Plate match', FAIL: 'Plate mismatch', NA: null },
  outwardCheck: { PASS: 'Authorization present', FAIL: 'Authorization missing', NA: null },
} as const;

/**
 * Visitor & security log (W5.13, D-62): visitor / contractor register, outward material passes
 * (OM, maker-checker authorization) and security checks (manual or AUTO, e.g. the exit-weight
 * mismatch of a turned-away truck). Mobiles are masked in lists; visitors are anonymised by the
 * retention job.
 */
export class GateSecurityService {
  constructor(
    private readonly deps: Pick<
      Cradle,
      'gateRegistersRepository' | 'gateRepository' | 'gateSupport' | 'runInTransaction'
    >,
  ) {}

  private get repo() {
    return this.deps.gateRegistersRepository;
  }
  private get support() {
    return this.deps.gateSupport;
  }

  private visitorView(v: VisitorRow, full: boolean) {
    return {
      id: v.id,
      visitorNo: v.visitorNo,
      name: v.name,
      mobile: full ? formatMobile(v.mobile) : maskMobile(v.mobile),
      company: v.company,
      purpose: v.purpose,
      host: v.hostLabel,
      hostUserId: v.hostUserId,
      gateEntryId: v.gateEntryId,
      status: v.status,
      statusLabel: VISITOR_LABEL[v.status] ?? v.status,
      action: v.status === 'PENDING' ? 'CHECK' : 'VIEW',
      entryAt: v.entryAt?.toISOString() ?? null,
      exitAt: v.exitAt?.toISOString() ?? null,
      anonymized: v.anonymizedAt !== null,
      createdAt: v.createdAt.toISOString(),
      version: v.version,
    };
  }

  private outwardView(o: OutwardRow) {
    return {
      id: o.id,
      omNo: o.omNo,
      material: o.material,
      qty: num(o.qty),
      unit: o.unit,
      quantityLabel: `${String(num(o.qty))} ${o.unit}`,
      vehicleRegNo: o.vehicleRegNo,
      vehicleDisplay: o.vehicleRegNo === null ? null : formatRegNo(o.vehicleRegNo),
      receiver: o.receiver,
      remarks: o.remarks,
      status: o.status,
      statusLabel: OUTWARD_LABEL[o.status] ?? o.status,
      createdBy: o.createdBy,
      authorizedBy: o.authorizedBy,
      authorizedAt: o.authorizedAt?.toISOString() ?? null,
      exitedAt: o.exitedAt?.toISOString() ?? null,
      createdAt: o.createdAt.toISOString(),
      version: o.version,
    };
  }

  private checkView(c: CheckRow) {
    const parts = (['identityCheck', 'plateCheck', 'outwardCheck'] as const)
      .map((k) => CHECK_TEXT[k][c[k]])
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const open = c.result === 'HOLD' && c.resolvedAt === null;
    return {
      id: c.id,
      subjectType: c.subjectType,
      subjectId: c.subjectId,
      subjectRef: c.subjectRef,
      title: c.subjectType === 'ENTRY' ? `Gate ${c.subjectRef}` : c.subjectRef,
      summary:
        c.reason === 'EXIT_WEIGHT_MISMATCH'
          ? 'Exit weight differs from gross'
          : parts.join(' · ') || (c.remarks ?? ''),
      identityCheck: c.identityCheck,
      plateCheck: c.plateCheck,
      outwardCheck: c.outwardCheck,
      source: c.source,
      reason: c.reason,
      remarks: c.remarks,
      result: c.result,
      status: open ? 'PENDING' : c.result === 'HOLD' ? 'RESOLVED' : 'VERIFIED',
      statusLabel: open ? 'Pending' : c.result === 'HOLD' ? 'Resolved' : 'Verified',
      createdAt: c.createdAt.toISOString(),
      resolvedAt: c.resolvedAt?.toISOString() ?? null,
      resolutionNote: c.resolutionNote,
    };
  }

  async summary(caller: Caller, warehouseId: string) {
    const w = await this.support.warehouse(caller, warehouseId, 'gate.view');
    const t = this.support.today(w);
    const [v, outward, holds] = await Promise.all([
      this.repo.visitorCounts(w.id, t.from, t.to),
      this.repo.outwardIssuedToday(w.id, t.from, t.to),
      this.repo.openHoldCount(w.id),
    ]);
    return {
      date: t.date,
      visitorsToday: { value: v.today, caption: `${String(v.checkedOut)} checked out` },
      onSite: { value: v.onSite, caption: 'Authorized visitors' },
      outwardMaterial: { value: outward, caption: 'Passes issued' },
      securityHolds: { value: holds, caption: holds > 0 ? 'Needs review' : 'No holds' },
    };
  }

  // ── visitors ──

  async visitors(
    caller: Caller,
    q: { warehouseId: string; status?: string; date?: string; q?: string },
    p: Paging,
  ) {
    const w = await this.support.warehouse(caller, q.warehouseId, 'gate.view');
    const c = decodeCursor(p.cursor);
    const b = q.date === undefined ? null : dayBounds(q.date, w.timezone);
    const rows = await this.repo.listVisitors(
      {
        warehouseId: w.id,
        ...(q.status === undefined ? {} : { status: q.status }),
        ...(q.q === undefined ? {} : { q: q.q }),
        ...(b === null ? {} : { from: b.from, to: b.to }),
      },
      c === null ? null : { at: new Date(String(c[0])), id: String(c[1]) },
      p.limit,
    );
    const page = toPageResult(rows, p, (r) => [r.createdAt.toISOString(), r.id]);
    return { ...page, items: page.items.map((v) => this.visitorView(v, false)) };
  }

  private async visitorOf(caller: Caller, id: string, key: string) {
    const v = await this.repo.visitor(id);
    if (v === null) throw new NotFoundError('Visitor');
    await this.support.warehouse(caller, v.warehouseId, key);
    return v;
  }

  async visitor(caller: Caller, id: string) {
    return this.visitorView(await this.visitorOf(caller, id, 'gate.view'), true);
  }

  async createVisitor(caller: Caller, input: VisitorInput) {
    const w = await this.support.warehouse(caller, input.warehouseId, 'gate.security');
    const v = await this.deps.runInTransaction(async (tx) => {
      const visitorNo = await this.support.nextNo(tx, 'VIS');
      const row = await this.repo.createVisitor(tx, {
        visitorNo,
        warehouseId: w.id,
        name: input.name,
        mobile: input.mobile ?? null,
        company: input.company ?? null,
        purpose: input.purpose,
        hostLabel: input.hostLabel ?? null,
        hostUserId: input.hostUserId ?? null,
        gateEntryId: input.gateEntryId ?? null,
        status: input.checkIn === true ? 'ON_SITE' : 'PENDING',
        entryAt: input.checkIn === true ? new Date() : null,
        createdBy: caller.userId,
      });
      await this.support.audit(tx, caller, 'gate.visitor_recorded', 'gate_visitor', row.id, {
        visitorNo,
        name: input.name,
        mobile: input.mobile ?? null,
        purpose: input.purpose,
      });
      return row;
    });
    await this.support.bump(w.id);
    return this.visitorView(v, true);
  }

  async moveVisitor(caller: Caller, id: string, to: 'ON_SITE' | 'CHECKED_OUT' | 'DENIED') {
    const v = await this.visitorOf(caller, id, 'gate.security');
    const from = to === 'ON_SITE' ? ['PENDING'] : to === 'CHECKED_OUT' ? ['ON_SITE'] : ['PENDING'];
    const after = await this.deps.runInTransaction(async (tx) => {
      const row = await this.repo.updateVisitorIf(tx, id, from, {
        status: to,
        ...(to === 'ON_SITE' ? { entryAt: new Date() } : {}),
        ...(to === 'CHECKED_OUT' ? { exitAt: new Date() } : {}),
      });
      if (row === null)
        throw conflict(
          'STALE_STATE',
          `The visitor is ${v.status.toLowerCase().replaceAll('_', ' ')}`,
          { status: v.status },
        );
      await this.support.audit(
        tx,
        caller,
        `gate.visitor_${to.toLowerCase()}`,
        'gate_visitor',
        id,
        { status: to },
        { status: v.status },
      );
      return row;
    });
    await this.support.bump(v.warehouseId);
    return this.visitorView(after, true);
  }

  // ── outward material ──

  async outward(
    caller: Caller,
    q: { warehouseId: string; status?: string; date?: string },
    p: Paging,
  ) {
    const w = await this.support.warehouse(caller, q.warehouseId, 'gate.view');
    const c = decodeCursor(p.cursor);
    const b = q.date === undefined ? null : dayBounds(q.date, w.timezone);
    const rows = await this.repo.listOutward(
      {
        warehouseId: w.id,
        ...(q.status === undefined ? {} : { status: q.status }),
        ...(b === null ? {} : { from: b.from, to: b.to }),
      },
      c === null ? null : { at: new Date(String(c[0])), id: String(c[1]) },
      p.limit,
    );
    const page = toPageResult(rows, p, (r) => [r.createdAt.toISOString(), r.id]);
    return { ...page, items: page.items.map((o) => this.outwardView(o)) };
  }

  async createOutward(caller: Caller, input: OutwardInput) {
    const w = await this.support.warehouse(caller, input.warehouseId, 'gate.security');
    const o = await this.deps.runInTransaction(async (tx) => {
      const omNo = await this.support.nextNo(tx, 'OM');
      const row = await this.repo.createOutward(tx, {
        omNo,
        warehouseId: w.id,
        material: input.material,
        qty: input.qty,
        unit: input.unit,
        vehicleRegNo:
          (input.vehicleRegNo ?? null) === null ? null : normalizeRegNo(input.vehicleRegNo ?? ''),
        receiver: input.receiver ?? null,
        remarks: input.remarks ?? null,
        createdBy: caller.userId,
      });
      await this.support.audit(tx, caller, 'gate.outward_recorded', 'outward_material', row.id, {
        omNo,
        material: input.material,
        qty: input.qty,
        unit: input.unit,
      });
      return row;
    });
    await this.support.bump(w.id);
    return this.outwardView(o);
  }

  async moveOutward(
    caller: Caller,
    id: string,
    to: 'AUTHORIZED' | 'REJECTED' | 'EXITED',
    note: string | null,
  ) {
    const o = await this.repo.outward(id);
    if (o === null) throw new NotFoundError('Outward material');
    await this.support.warehouse(
      caller,
      o.warehouseId,
      to === 'EXITED' ? 'gate.security' : 'gate.approve',
    );
    if (to !== 'EXITED' && o.createdBy === caller.userId)
      throw new ForbiddenError('The person who recorded the material cannot authorize it', {
        details: { reason: 'SAME_USER' },
      });
    const after = await this.deps.runInTransaction(async (tx) => {
      if (to === 'EXITED' && (await this.repo.openHolds(tx, id)).length > 0)
        throw conflict('SECURITY_HOLD', 'A security hold is open for this material');
      const row = await this.repo.updateOutwardIf(
        tx,
        id,
        to === 'EXITED' ? ['AUTHORIZED'] : ['PENDING_AUTH'],
        {
          status: to,
          ...(to === 'EXITED'
            ? { exitedAt: new Date(), exitedBy: caller.userId }
            : { authorizedAt: new Date(), authorizedBy: caller.userId }),
        },
      );
      if (row === null)
        throw conflict(
          'STALE_STATE',
          `The material pass is ${o.status.toLowerCase().replaceAll('_', ' ')}`,
          { status: o.status },
        );
      await this.support.audit(
        tx,
        caller,
        `gate.outward_${to.toLowerCase()}`,
        'outward_material',
        id,
        { status: to },
        { status: o.status },
        note,
      );
      return row;
    });
    await this.support.bump(o.warehouseId);
    return this.outwardView(after);
  }

  // ── security checks ──

  async checks(
    caller: Caller,
    q: { warehouseId: string; result?: string; open?: boolean },
    p: Paging,
  ) {
    const w = await this.support.warehouse(caller, q.warehouseId, 'gate.view');
    const c = decodeCursor(p.cursor);
    const rows = await this.repo.listChecks(
      {
        warehouseId: w.id,
        ...(q.result === undefined ? {} : { result: q.result }),
        ...(q.open === undefined ? {} : { open: q.open }),
      },
      c === null ? null : { at: new Date(String(c[0])), id: String(c[1]) },
      p.limit,
    );
    const page = toPageResult(rows, p, (r) => [r.createdAt.toISOString(), r.id]);
    return { ...page, items: page.items.map((x) => this.checkView(x)) };
  }

  async createCheck(caller: Caller, input: CheckInput) {
    const w = await this.support.warehouse(caller, input.warehouseId, 'gate.security');
    let ref: string;
    if (input.subjectType === 'ENTRY') {
      const e = await this.deps.gateRepository.entry(input.subjectId);
      if (e?.warehouseId !== w.id)
        throw new ValidationError([{ path: 'body.subjectId', message: 'unknown gate entry' }]);
      ref = e.entryNo;
    } else if (input.subjectType === 'VISITOR') {
      const v = await this.repo.visitor(input.subjectId);
      if (v?.warehouseId !== w.id)
        throw new ValidationError([{ path: 'body.subjectId', message: 'unknown visitor' }]);
      ref = v.visitorNo;
    } else {
      const o = await this.repo.outward(input.subjectId);
      if (o?.warehouseId !== w.id)
        throw new ValidationError([
          { path: 'body.subjectId', message: 'unknown outward material' },
        ]);
      ref = o.omNo;
    }
    const checks = [input.identityCheck, input.plateCheck, input.outwardCheck];
    const hold = checks.includes('FAIL');
    if (hold && (input.remarks ?? '').trim().length < 5)
      throw new ValidationError([
        { path: 'body.remarks', message: 'describe the discrepancy (≥ 5 characters)' },
      ]);
    const row = await this.deps.runInTransaction(async (tx) => {
      const created = await this.repo.createCheck(tx, {
        warehouseId: w.id,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        subjectRef: ref,
        identityCheck: input.identityCheck ?? 'NA',
        plateCheck: input.plateCheck ?? 'NA',
        outwardCheck: input.outwardCheck ?? 'NA',
        source: 'MANUAL',
        remarks: input.remarks ?? null,
        result: hold ? 'HOLD' : 'CLEAR',
        createdBy: caller.userId,
      });
      // A clear check admits a pending visitor.
      if (!hold && input.subjectType === 'VISITOR')
        await this.repo.updateVisitorIf(tx, input.subjectId, ['PENDING'], {
          status: 'ON_SITE',
          entryAt: new Date(),
        });
      if (input.subjectType === 'ENTRY') {
        const e = await this.deps.gateRepository.entry(input.subjectId, tx);
        if (e !== null)
          await this.support.event(tx, {
            warehouseId: w.id,
            shipmentId: e.shipmentId,
            gateEntryId: e.id,
            type: hold ? 'SECURITY_HOLD' : 'SECURITY_CLEAR',
            byUserId: caller.userId,
            data: { checkId: created.id },
          });
      }
      await this.support.audit(
        tx,
        caller,
        'gate.security_check',
        'security_check',
        created.id,
        { subjectType: input.subjectType, subjectRef: ref, result: created.result },
        null,
        input.remarks ?? null,
      );
      return created;
    });
    await this.support.bump(w.id);
    return this.checkView(row);
  }

  async resolveCheck(caller: Caller, id: string, input: { note: string; deny?: boolean }) {
    const c = await this.repo.check(id);
    if (c === null) throw new NotFoundError('Security check');
    await this.support.warehouse(caller, c.warehouseId, 'gate.approve');
    const row = await this.deps.runInTransaction(async (tx) => {
      const r = await this.repo.resolveCheckIf(tx, id, {
        resolvedBy: caller.userId,
        resolutionNote: input.note,
      });
      if (r === null) throw conflict('STALE_STATE', 'The check is not an open hold');
      if (c.subjectType === 'VISITOR')
        await this.repo.updateVisitorIf(
          tx,
          c.subjectId,
          ['PENDING'],
          input.deny === true ? { status: 'DENIED' } : { status: 'ON_SITE', entryAt: new Date() },
        );
      if (c.subjectType === 'OUTWARD' && input.deny === true)
        await this.repo.updateOutwardIf(tx, c.subjectId, ['PENDING_AUTH', 'AUTHORIZED'], {
          status: 'REJECTED',
        });
      await this.support.audit(
        tx,
        caller,
        'gate.security_resolved',
        'security_check',
        id,
        { resolved: true, deny: input.deny === true },
        { result: c.result },
        input.note,
      );
      return r;
    });
    await this.support.bump(c.warehouseId);
    return this.checkView(row);
  }
}
