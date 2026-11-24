import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { Caller } from '../../middleware/guards.js';
import {
  type Paging,
  csvCell,
  decodeCursor,
  offsetOf,
  toPageResult,
} from '../../middleware/paging.js';
import type { ExceptionRow, JsonInput } from './fulfilment.repository.js';
import { exceptionDue, istDay, istStart } from './fulfilment.rules.js';

type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
type ExType = ExceptionRow['type'];
type Cause = NonNullable<ExceptionRow['cause']>;

export interface RaiseInput {
  type: ExType;
  cause?: Cause | null;
  severity?: Severity;
  warehouseId: string;
  orderId?: string | null;
  shipmentId?: string | null;
  variantId?: string | null;
  batchId?: string | null;
  requiredQty?: number;
  availableQty?: number;
  impactedQty?: number;
  reportedLocation?: string | null;
  expectedRef?: string | null;
  title: string;
  diagnostic?: Record<string, unknown>;
  proposal?: Record<string, unknown>;
  dedupeKey?: string | null;
  reportedBy?: string | null;
}

const TYPE_LABEL: Record<ExType, string> = {
  SHORTAGE: 'Shortage',
  PARTIAL: 'Partial',
  CANCELLATION: 'Cancellation',
  ALLOCATION_ISSUE: 'Allocation issue',
  QUALITY: 'Quality',
  DELIVERY: 'Delivery',
  STOCK_DRIFT: 'Stock drift',
  ALLOCATION_MISMATCH: 'Allocation mismatch',
  ISSUE_MISMATCH: 'Issue mismatch',
};

/** Resolve actions available now (SPLIT / BACKORDER / PARTIAL_SHIP arrive with Phase 5). */
export const RESOLVE_ACTIONS = [
  'REALLOCATE',
  'RETRY_ALLOCATION',
  'RESTOCK',
  'WRITE_OFF',
  'SPLIT',
  'BACKORDER',
  'PARTIAL_SHIP',
  'CANCEL_LINES',
  'NO_ACTION',
] as const;
export type ResolveAction = (typeof RESOLVE_ACTIONS)[number];

/**
 * Order exceptions (W3.11): raised by the floor, jobs (reconcile, SLA) and people; each has an
 * SLA from its severity, a diagnostic and a proposal. Jobs pass a `dedupeKey`, so a problem is
 * raised once while it is open. Resolving runs the chosen action and records who did what.
 */
export class FulfilmentExceptions {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'fulfilmentRepository'
      | 'fulfilmentReadRepository'
      | 'fulfilmentSettings'
      | 'stockService'
      | 'runInTransaction'
      | 'auditService'
      | 'warehousesService'
      | 'fulfilmentOrders'
      | 'fulfilmentFefo'
    >,
  ) {}

  private get repo() {
    return this.deps.fulfilmentRepository;
  }

  /** Inside the caller's tx; returns the open exception with the same dedupe key if any. */
  async raise(tx: Tx, i: RaiseInput): Promise<ExceptionRow> {
    if (i.dedupeKey !== undefined && i.dedupeKey !== null) {
      const open = await this.repo.openByDedupe(tx, i.dedupeKey);
      if (open !== null) return open;
    }
    const severity = i.severity ?? 'MEDIUM';
    const now = new Date();
    const sla = await this.deps.fulfilmentSettings.get(
      'fulfilment.exceptionSlaHours',
      i.warehouseId,
    );
    let kg = 0;
    if (i.variantId !== undefined && i.variantId !== null && (i.impactedQty ?? 0) > 0) {
      const [v] = await this.deps.stockService.variantRows([i.variantId], tx);
      kg = ((v?.weightGrams ?? 0) * (i.impactedQty ?? 0)) / 1000;
    }
    const row = await this.repo.createException(tx, {
      exNo: await this.deps.stockService.nextDocNo(tx, 'EX'),
      type: i.type,
      cause: i.cause ?? null,
      severity,
      warehouseId: i.warehouseId,
      orderId: i.orderId ?? null,
      shipmentId: i.shipmentId ?? null,
      variantId: i.variantId ?? null,
      batchId: i.batchId ?? null,
      requiredQty: i.requiredQty ?? 0,
      availableQty: i.availableQty ?? 0,
      impactedQty: i.impactedQty ?? 0,
      impactedKg: kg.toFixed(3),
      reportedLocation: i.reportedLocation ?? null,
      expectedRef: i.expectedRef ?? null,
      title: i.title.slice(0, 200),
      diagnostic: (i.diagnostic ?? {}) as JsonInput,
      proposal: (i.proposal ?? {}) as JsonInput,
      slaDueAt: exceptionDue(now, severity, sla),
      reportedBy: i.reportedBy ?? null,
      dedupeKey: i.dedupeKey ?? null,
    });
    await this.repo.bumpDaily(tx, i.warehouseId, istDay(now), { exceptionsOpened: 1 });
    return row;
  }

  // ── W3.11 reads ──

  async kpis(caller: Caller, warehouseId: string | undefined, from?: string, to?: string) {
    const scope = this.scope(caller, warehouseId);
    const since = istStart(istDay(new Date()));
    const k = await this.deps.fulfilmentReadRepository.exceptionKpis(scope, warehouseId, since, {
      ...(from === undefined ? {} : { from: istStart(from) }),
      ...(to === undefined ? {} : { to: new Date(istStart(to).getTime() + 86_400_000) }),
    });
    return {
      open: k.open,
      critical: k.critical,
      overdue: k.overdue,
      sinceShiftStart: k.sinceToday,
      impactedKg: k.impactedKg,
      restockRequiredOrders: k.restockOrders,
      dockReturned: k.dockReturned,
      crossWarehouseRouted: k.routed,
      activeReroutes: k.reroutes,
      byType: Object.fromEntries(
        (Object.keys(TYPE_LABEL) as ExType[]).map((t) => [t, k.byType[t] ?? 0]),
      ),
      tabs: [
        { key: 'all', label: 'All', count: k.open },
        ...(
          [
            'SHORTAGE',
            'PARTIAL',
            'CANCELLATION',
            'ALLOCATION_ISSUE',
            'QUALITY',
            'DELIVERY',
          ] as const
        ).map((t) => ({ key: t, label: TYPE_LABEL[t], count: k.byType[t] ?? 0 })),
      ],
      asOf: new Date().toISOString(),
    };
  }

  async list(
    caller: Caller,
    f: {
      type?: string;
      status?: string;
      severity?: string;
      q?: string;
      from?: string;
      to?: string;
      warehouseId?: string;
      customerId?: string;
    },
    p: Paging,
  ) {
    const scope = this.scope(caller, f.warehouseId);
    const offset = offsetOf(p);
    const filter = {
      ...f,
      ...(f.from === undefined ? {} : { fromAt: istStart(f.from) }),
      ...(f.to === undefined ? {} : { toAt: new Date(istStart(f.to).getTime() + 86_400_000) }),
    };
    const [rows, total] = await Promise.all([
      this.deps.fulfilmentReadRepository.exceptions(scope, filter, {
        limit: p.limit,
        offset,
        after: decodeCursor(p.cursor),
      }),
      offset === null
        ? Promise.resolve(undefined)
        : this.deps.fulfilmentReadRepository.exceptionsCount(scope, filter),
    ]);
    const page = toPageResult(rows, p, (r) => [r.slaDueAt?.toISOString() ?? null, r.id], total);
    return { ...page, items: page.items.map((r) => this.row(r)) };
  }

  async get(caller: Caller, id: string) {
    const e = await this.repo.exception(id);
    if (e === null) throw new NotFoundError('Exception');
    caller.access.require('fulfilment.view', e.warehouseId);
    const [ctx] = await this.deps.fulfilmentReadRepository.exceptionContext([e.id]);
    return {
      ...this.row({ ...e, ...ctx }),
      diagnostic: e.diagnostic,
      proposal: e.proposal,
      resolution: e.resolution,
      assignedTo: e.assignedTo,
      resolvedBy: e.resolvedBy,
      resolvedAt: e.resolvedAt,
      version: e.version,
      actions: RESOLVE_ACTIONS,
    };
  }

  async create(caller: Caller, input: Omit<RaiseInput, 'dedupeKey' | 'reportedBy'>) {
    await this.deps.warehousesService.requireVisible(
      caller,
      input.warehouseId,
      'inventory.exception_raise',
    );
    const id = await this.deps.runInTransaction(async (tx) => {
      const e = await this.raise(tx, { ...input, reportedBy: caller.userId });
      await this.audit(tx, caller, 'exception.raised', e.id, { type: e.type, title: e.title });
      return e.id;
    });
    return this.get(caller, id);
  }

  async patch(
    caller: Caller,
    id: string,
    input: {
      status?: 'OPEN' | 'IN_REVIEW' | 'CLOSED';
      severity?: Severity;
      assignedTo?: string | null;
      expectedRef?: string | null;
      reportedLocation?: string | null;
      note?: string | null;
      expectedVersion: number;
    },
  ) {
    await this.deps.runInTransaction(async (tx) => {
      const e = await this.lock(tx, caller, id);
      if (e.version !== input.expectedVersion)
        throw new ConflictError('The exception changed', {
          details: { reason: 'VERSION_CONFLICT' },
        });
      if (e.status === 'RESOLVED' || e.status === 'CLOSED')
        throw new ConflictError('The exception is closed', {
          details: { reason: 'INVALID_STATE' },
        });
      const sla = await this.deps.fulfilmentSettings.get(
        'fulfilment.exceptionSlaHours',
        e.warehouseId,
      );
      await this.repo.updateException(tx, id, {
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.severity === undefined
          ? {}
          : { severity: input.severity, slaDueAt: exceptionDue(e.createdAt, input.severity, sla) }),
        ...(input.assignedTo === undefined ? {} : { assignedTo: input.assignedTo }),
        ...(input.expectedRef === undefined ? {} : { expectedRef: input.expectedRef }),
        ...(input.reportedLocation === undefined
          ? {}
          : { reportedLocation: input.reportedLocation }),
        ...(input.status === 'CLOSED'
          ? {
              resolvedAt: new Date(),
              resolvedBy: caller.userId,
              resolution: { action: 'CLOSED', note: input.note ?? null },
            }
          : {}),
      });
      await this.audit(tx, caller, 'exception.updated', id, input, input.note ?? null);
    });
    return this.get(caller, id);
  }

  /** Runs one resolve action and records it (W3.11 Resolve / Allocate / Restock / Re-allocate). */
  async resolve(
    caller: Caller,
    id: string,
    input: { action: ResolveAction; params?: Record<string, unknown>; note?: string | null },
  ) {
    const e = await this.repo.exception(id);
    if (e === null) throw new NotFoundError('Exception');
    caller.access.require('fulfilment.manage', e.warehouseId);
    if (e.status === 'RESOLVED' || e.status === 'CLOSED')
      throw new ConflictError('The exception is closed', { details: { reason: 'INVALID_STATE' } });
    const params = input.params ?? {};
    let outcome: Record<string, unknown> = {};
    switch (input.action) {
      case 'REALLOCATE': {
        if (e.orderId === null) throw this.needs('an order');
        const to = params.warehouseId;
        if (typeof to !== 'string')
          throw new ValidationError([{ path: 'body.params.warehouseId', message: 'is required' }]);
        const r = await this.deps.fulfilmentOrders.allocate(caller, e.orderId, {
          warehouseId: to,
          reason: input.note ?? `Exception ${e.exNo}`,
          ...(e.variantId === null ? {} : { variantIds: [e.variantId] }),
        });
        outcome = { reallocationId: r.id, status: r.status };
        break;
      }
      case 'RETRY_ALLOCATION': {
        if (e.shipmentId === null) throw this.needs('a shipment');
        outcome = await this.deps.fulfilmentFefo.reserve(caller, e.shipmentId, {});
        break;
      }
      case 'RESTOCK':
      case 'WRITE_OFF': {
        const positionId = params.positionId;
        const qty = params.qty;
        if (typeof positionId !== 'string' || typeof qty !== 'number')
          throw new ValidationError([
            { path: 'body.params', message: 'positionId and qty are required' },
          ]);
        const from =
          typeof params.from === 'string'
            ? params.from
            : input.action === 'RESTOCK'
              ? 'RETURNED'
              : 'DAMAGED';
        await this.deps.stockService.statusChange(caller, {
          positionId,
          from: from as never,
          to: input.action === 'RESTOCK' ? 'AVAILABLE' : 'WRITTEN_OFF',
          qty,
          reason: input.note ?? `Exception ${e.exNo}`,
        });
        outcome = { positionId, qty, from };
        break;
      }
      case 'SPLIT':
      case 'BACKORDER':
      case 'PARTIAL_SHIP':
        outcome = await this.deps.fulfilmentOrders.resolveShortage(caller, e, input.action, params);
        break;
      case 'CANCEL_LINES':
        throw new ConflictError('Cancel order lines through the order cancellation (W3.15)', {
          details: { reason: 'USE_ORDER_CANCELLATION', orderId: e.orderId },
        });
      case 'NO_ACTION':
        break;
    }
    await this.deps.runInTransaction(async (tx) => {
      await this.repo.updateException(tx, id, {
        status: 'RESOLVED',
        resolvedAt: new Date(),
        resolvedBy: caller.userId,
        resolution: {
          action: input.action,
          params,
          outcome,
          note: input.note ?? null,
        } as JsonInput,
      });
      await this.audit(
        tx,
        caller,
        'exception.resolved',
        id,
        { action: input.action, outcome },
        input.note ?? null,
      );
    });
    return this.get(caller, id);
  }

  /** Mass actions (W3.11 "Mass re-route" / "Hold selected" / close). Each id on its own. */
  async bulk(
    caller: Caller,
    input: {
      ids: string[];
      action: 'HOLD' | 'REROUTE' | 'CLOSE' | 'ASSIGN';
      warehouseId?: string;
      assignedTo?: string;
      note?: string;
    },
  ) {
    const results: { id: string; ok: boolean; reason: string | null }[] = [];
    for (const id of new Set(input.ids)) {
      try {
        const e = await this.repo.exception(id);
        if (e === null) throw new NotFoundError('Exception');
        if (input.action === 'HOLD') {
          if (e.orderId === null) throw this.needs('an order');
          await this.deps.fulfilmentOrders.hold(caller, e.orderId, {
            reasonCode: 'OPERATIONS',
            note: input.note ?? `Exception ${e.exNo}`,
          });
        } else if (input.action === 'REROUTE')
          await this.resolve(caller, id, {
            action: 'REALLOCATE',
            params: { warehouseId: input.warehouseId },
            note: input.note ?? null,
          });
        else if (input.action === 'CLOSE')
          await this.patch(caller, id, {
            status: 'CLOSED',
            note: input.note ?? null,
            expectedVersion: e.version,
          });
        else
          await this.patch(caller, id, {
            assignedTo: input.assignedTo ?? null,
            expectedVersion: e.version,
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

  async *csv(caller: Caller, f: Parameters<FulfilmentExceptions['list']>[1]) {
    yield 'Exception,Type,Severity,Status,Order,Warehouse,SKU,Required,Available,Impacted,Impacted kg,SLA due,Created\n';
    let cursor: string | undefined;
    for (;;) {
      const page = await this.list(caller, f, {
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const r of page.items)
        yield `${[
          r.exNo,
          r.type,
          r.severity,
          r.status,
          r.orderNo,
          r.warehouse.code,
          r.sku,
          r.requiredQty,
          r.availableQty,
          r.impactedQty,
          r.impactedKg,
          r.slaDueAt,
          r.createdAt,
        ]
          .map((v) => csvCell(v))
          .join(',')}\n`;
      if (page.nextCursor === null) return;
      cursor = page.nextCursor;
    }
  }

  // ── helpers ──

  private row(
    r: ExceptionRow & {
      orderNo?: string | null;
      customerName?: string | null;
      customerPoRef?: string | null;
      orderCancelled?: boolean;
      sku?: string | null;
      productName?: string | null;
      warehouseCode?: string | null;
      warehouseName?: string | null;
      packageSummary?: string | null;
    },
  ) {
    const now = Date.now();
    return {
      id: r.id,
      exNo: r.exNo,
      type: r.type,
      typeLabel: TYPE_LABEL[r.type],
      cause: r.cause,
      severity: r.severity,
      status: r.status,
      title: r.title,
      orderId: r.orderId,
      orderNo: r.orderNo ?? null,
      orderCancelled: r.orderCancelled ?? false,
      customerName: r.customerName ?? null,
      customerPoRef: r.customerPoRef ?? null,
      packageSummary: r.packageSummary ?? null,
      shipmentId: r.shipmentId,
      warehouse: {
        id: r.warehouseId,
        code: r.warehouseCode ?? null,
        name: r.warehouseName ?? null,
      },
      variantId: r.variantId,
      sku: r.sku ?? null,
      productName: r.productName ?? null,
      batchId: r.batchId,
      requiredQty: r.requiredQty,
      availableQty: r.availableQty,
      impactedQty: r.impactedQty,
      impactedKg: Number(r.impactedKg.toFixed(3)),
      reportedLocation: r.reportedLocation,
      expectedRef: r.expectedRef,
      slaDueAt: r.slaDueAt,
      overdue:
        r.slaDueAt !== null &&
        r.slaDueAt.getTime() < now &&
        (r.status === 'OPEN' || r.status === 'IN_REVIEW'),
      createdAt: r.createdAt,
    };
  }

  private scope(caller: Caller, warehouseId?: string) {
    if (warehouseId !== undefined) caller.access.require('fulfilment.view', warehouseId);
    return caller.access.scope('fulfilment.view');
  }

  private async lock(tx: Tx, caller: Caller, id: string) {
    const e = await this.repo.lockException(tx, id);
    if (e === null) throw new NotFoundError('Exception');
    caller.access.require('fulfilment.manage', e.warehouseId);
    return e;
  }

  private needs(what: string) {
    return new ConflictError(`This exception has no ${what}`, {
      details: { reason: 'NOT_APPLICABLE' },
    });
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
        targetType: 'exception',
        targetId: id,
        after: after as Record<string, unknown>,
        reason,
      },
    );
  }
}
