import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';
import { uuidv7 } from '../../adapters/uuid.js';
import type { Caller } from '../../middleware/guards.js';
import { type Paging, decodeCursor, offsetOf, toPageResult } from '../../middleware/paging.js';
import type { StockMove } from '../stock/index.js';
import type { RequestRow, TransferRow } from './restock.repository.js';

const actorOf = (c: Caller) => ({ userId: c.userId, ip: c.ip, requestId: c.requestId });
const ymd = (d: Date | null) => (d === null ? null : d.toISOString().slice(0, 10));
const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

export interface RequestInput {
  type: 'PROCUREMENT' | 'TRANSFER';
  destWarehouseId: string;
  sourceWarehouseId?: string | null;
  vendorId?: string | null;
  requiredBy: string;
  periodMonth?: string;
  notes?: string | null;
  lines: { variantId: string; requestedQty: number }[];
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  IN_TRANSIT: 'In transit',
  PARTIALLY_RECEIVED: 'Partially received',
  RECEIVED: 'Received',
};

/**
 * Restock (W4.07 / W4.08, D-57a): procurement or warehouse-transfer requests with maker-checker
 * approval. "Inventory is not updated until approved stock is received": procurement lands via
 * the stock receipt (CN) API, transfers via dispatch (FEFO, AVAILABLE → IN_TRANSIT) and receive
 * (IN_TRANSIT → QC hold at the destination).
 */
export class RestockService {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'restockRepository'
      | 'stockService'
      | 'stockEngine'
      | 'stockQueries'
      | 'warehousesService'
      | 'runInTransaction'
      | 'auditService'
    >,
  ) {}

  private get repo() {
    return this.deps.restockRepository;
  }

  // ── requests ──

  async prefill(caller: Caller, warehouseId: string, variantIds: readonly string[]) {
    caller.access.require('inventory.view', warehouseId);
    const levels = await this.deps.stockService.levelsFor(warehouseId, variantIds);
    return variantIds.map((variantId) => {
      const l = levels.get(variantId);
      return {
        variantId,
        sku: l?.sku ?? null,
        name: l?.name ?? null,
        warehouseId,
        available: l?.available ?? 0,
        minimum: l?.reorderLevel ?? 0,
        target: l?.targetStock ?? 0,
        inbound: l?.inbound ?? 0,
        suggestedQty: l?.suggested ?? 0,
      };
    });
  }

  async create(caller: Caller, input: RequestInput) {
    await this.deps.warehousesService.requireVisible(
      caller,
      input.destWarehouseId,
      'inventory.restock_request',
    );
    this.assertShape(input);
    await this.deps.stockService.ensureVariants(input.lines.map((l) => l.variantId));
    const levels = await this.deps.stockService.levelsFor(
      input.destWarehouseId,
      input.lines.map((l) => l.variantId),
    );
    const id = await this.deps.runInTransaction(async (tx) => {
      const requestNo = await this.deps.stockService.nextDocNo(tx, 'RST');
      const r = await this.repo.createRequest(tx, {
        id: uuidv7(),
        requestNo,
        type: input.type,
        destWarehouseId: input.destWarehouseId,
        sourceWarehouseId: input.type === 'TRANSFER' ? (input.sourceWarehouseId ?? null) : null,
        vendorId: input.type === 'PROCUREMENT' ? (input.vendorId ?? null) : null,
        requiredBy: new Date(`${input.requiredBy}T00:00:00.000Z`),
        periodMonth:
          input.periodMonth === undefined
            ? monthStart(new Date())
            : new Date(`${input.periodMonth}-01T00:00:00.000Z`),
        notes: input.notes ?? null,
        createdBy: caller.userId,
      });
      await this.repo.replaceLines(
        tx,
        r.id,
        input.lines.map((l) => ({
          variantId: l.variantId,
          requestedQty: l.requestedQty,
          availableAtRequest: levels.get(l.variantId)?.available ?? 0,
          suggestedQty: levels.get(l.variantId)?.suggested ?? 0,
        })),
      );
      await this.deps.auditService.record(tx, actorOf(caller), {
        action: 'restock.created',
        targetType: 'restock_request',
        targetId: r.id,
        after: { requestNo, type: input.type, lines: input.lines.length },
      });
      return r.id;
    });
    return this.view(caller, id);
  }

  async update(
    caller: Caller,
    id: string,
    input: Partial<RequestInput> & { expectedVersion: number },
  ) {
    await this.deps.runInTransaction(async (tx) => {
      const r = await this.mustLock(tx, caller, id, 'inventory.restock_request');
      if (r.status !== 'DRAFT') throw this.state('Only a draft can be edited');
      if (r.version !== input.expectedVersion)
        throw new ConflictError('The request changed', { details: { reason: 'VERSION_CONFLICT' } });
      const merged = {
        type: input.type ?? r.type,
        destWarehouseId: r.destWarehouseId,
        sourceWarehouseId:
          input.sourceWarehouseId === undefined ? r.sourceWarehouseId : input.sourceWarehouseId,
        vendorId: input.vendorId === undefined ? r.vendorId : input.vendorId,
        requiredBy: input.requiredBy ?? ymd(r.requiredBy) ?? '',
        lines:
          input.lines ??
          r.lines.map((l) => ({ variantId: l.variantId, requestedQty: l.requestedQty })),
      };
      this.assertShape(merged);
      await this.repo.updateRequest(tx, id, {
        type: merged.type,
        sourceWarehouseId: merged.type === 'TRANSFER' ? merged.sourceWarehouseId : null,
        vendorId: merged.type === 'PROCUREMENT' ? merged.vendorId : null,
        requiredBy: new Date(`${merged.requiredBy}T00:00:00.000Z`),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      });
      if (input.lines !== undefined) {
        const levels = await this.deps.stockService.levelsFor(
          r.destWarehouseId,
          input.lines.map((l) => l.variantId),
        );
        await this.repo.replaceLines(
          tx,
          id,
          input.lines.map((l) => ({
            variantId: l.variantId,
            requestedQty: l.requestedQty,
            availableAtRequest: levels.get(l.variantId)?.available ?? 0,
            suggestedQty: levels.get(l.variantId)?.suggested ?? 0,
          })),
        );
      }
      await this.deps.auditService.record(tx, actorOf(caller), {
        action: 'restock.updated',
        targetType: 'restock_request',
        targetId: id,
        after: input,
      });
    });
    return this.view(caller, id);
  }

  async submit(caller: Caller, id: string) {
    return this.transition(
      caller,
      id,
      'inventory.restock_request',
      ['DRAFT'],
      'PENDING_APPROVAL',
      'restock.submitted',
      { submittedAt: new Date(), submittedBy: caller.userId },
    );
  }

  async cancel(caller: Caller, id: string, note: string | null) {
    return this.transition(
      caller,
      id,
      'inventory.restock_request',
      ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'],
      'CANCELLED',
      'restock.cancelled',
      { decisionNote: note },
    );
  }

  async decide(
    caller: Caller,
    id: string,
    approve: boolean,
    input: { note?: string | null; lines?: { variantId: string; approvedQty: number }[] },
  ) {
    await this.deps.runInTransaction(async (tx) => {
      const r = await this.repo.lockRequest(tx, id);
      if (r === null) throw new NotFoundError('Restock request');
      if (!caller.access.isGlobal('inventory.restock_approve')) throw new ForbiddenError();
      if (r.status !== 'PENDING_APPROVAL')
        throw this.state(`The request is ${STATUS_LABEL[r.status] ?? r.status}`);
      if (r.createdBy === caller.userId || r.submittedBy === caller.userId)
        throw new ForbiddenError(
          'Another person must approve this request (segregation of duties)',
        );
      if (approve)
        for (const l of r.lines) {
          const set = input.lines?.find((x) => x.variantId === l.variantId);
          await this.repo.updateLine(tx, id, l.variantId, {
            approvedQty: set?.approvedQty ?? l.requestedQty,
          });
        }
      await this.repo.updateRequest(tx, id, {
        status: approve ? 'APPROVED' : 'REJECTED',
        decidedAt: new Date(),
        decidedBy: caller.userId,
        decisionNote: input.note ?? null,
      });
      await this.deps.auditService.record(tx, actorOf(caller), {
        action: approve ? 'restock.approved' : 'restock.rejected',
        targetType: 'restock_request',
        targetId: id,
        after: input,
        reason: input.note ?? null,
      });
    });
    return this.view(caller, id);
  }

  async list(
    caller: Caller,
    q: { month?: string; status?: string; type?: string; warehouseId?: string },
    p: Paging,
  ) {
    if (q.warehouseId !== undefined) caller.access.require('inventory.view', q.warehouseId);
    const scope = caller.access.scope('inventory.view');
    const filter = {
      ...(q.month === undefined ? {} : { month: q.month }),
      ...(q.status === undefined ? {} : { status: q.status }),
      ...(q.type === undefined ? {} : { type: q.type }),
      ...(q.warehouseId === undefined ? {} : { warehouseId: q.warehouseId }),
    };
    const offset = offsetOf(p);
    const after = decodeCursor(p.cursor)?.[0];
    const [rows, total] = await Promise.all([
      this.repo.requests(scope, {
        ...filter,
        ...(typeof after === 'string' ? { cursor: after } : {}),
        limit: p.limit,
        offset,
      }),
      offset === null ? Promise.resolve(undefined) : this.repo.countRequests(scope, filter),
    ]);
    const page = toPageResult(rows, p, (r) => [r.id], total);
    const whs = await this.names(
      page.items.flatMap((r) => [r.destWarehouseId, r.sourceWarehouseId]),
    );
    return { ...page, items: page.items.map((r) => this.summaryView(r, whs)) };
  }

  async view(caller: Caller, id: string) {
    const r = await this.repo.request(id);
    if (r === null) throw new NotFoundError('Restock request');
    if (r.sourceWarehouseId === null || !caller.access.can('inventory.view', r.sourceWarehouseId))
      caller.access.require('inventory.view', r.destWarehouseId);
    const [whs, levels, vendors] = await Promise.all([
      this.names([r.destWarehouseId, r.sourceWarehouseId]),
      this.deps.stockService.levelsFor(
        r.destWarehouseId,
        r.lines.map((l) => l.variantId),
      ),
      this.deps.stockService.vendorNames([r.vendorId]),
    ]);
    return {
      ...this.summaryView(r, whs),
      vendor:
        r.vendorId === null ? null : (vendors.get(r.vendorId) ?? { id: r.vendorId, name: null }),
      notes: r.notes,
      decisionNote: r.decisionNote,
      submittedAt: r.submittedAt,
      decidedAt: r.decidedAt,
      version: r.version,
      lines: r.lines.map((l) => ({
        variantId: l.variantId,
        sku: levels.get(l.variantId)?.sku ?? null,
        name: levels.get(l.variantId)?.name ?? null,
        available: levels.get(l.variantId)?.available ?? l.availableAtRequest,
        suggestedQty: l.suggestedQty,
        requestedQty: l.requestedQty,
        approvedQty: l.approvedQty,
        dispatchedQty: l.dispatchedQty,
        receivedQty: l.receivedQty,
      })),
      approvalSummary: {
        products: r.lines.length,
        requestedPacks: r.lines.reduce((s, l) => s + l.requestedQty, 0),
        requestType: r.type === 'PROCUREMENT' ? 'Procurement' : 'Warehouse transfer',
        status: STATUS_LABEL[r.status] ?? r.status,
        note: 'Inventory is not updated until approved stock is received.',
      },
    };
  }

  // ── transfers ──

  /** Source warehouse ships an approved TRANSFER request: FEFO picks, AVAILABLE → IN_TRANSIT. */
  async dispatch(
    caller: Caller,
    id: string,
    input: { etaAt?: string; lines?: { variantId: string; qty: number }[] },
  ) {
    const transferId = await this.deps.runInTransaction(async (tx) => {
      const r = await this.repo.lockRequest(tx, id);
      if (r === null) throw new NotFoundError('Restock request');
      if (r.type !== 'TRANSFER' || r.sourceWarehouseId === null)
        throw this.state('Only a warehouse transfer can be dispatched');
      caller.access.require('inventory.transfer', r.sourceWarehouseId);
      if (r.status !== 'APPROVED') throw this.state('Approve the request before dispatch');
      const wanted = r.lines
        .map((l) => ({
          variantId: l.variantId,
          qty:
            input.lines?.find((x) => x.variantId === l.variantId)?.qty ??
            l.approvedQty ??
            l.requestedQty,
        }))
        .filter((l) => l.qty > 0);
      const moves: StockMove[] = [];
      const trLines: {
        lineNo: number;
        variantId: string;
        batchId: string;
        ownerType: 'SOR' | 'FARMX' | 'JIT';
        vendorId: string | null;
        qty: number;
      }[] = [];
      for (const l of wanted) {
        const picks = await this.deps.stockService.pickFefo(
          tx,
          r.sourceWarehouseId,
          l.variantId,
          l.qty,
        );
        for (const p of picks) {
          moves.push({
            type: 'TRANSFER_OUT',
            from: 'AVAILABLE',
            to: 'IN_TRANSIT',
            qty: p.qty,
            source: { id: p.positionId },
          });
          trLines.push({
            lineNo: trLines.length + 1,
            variantId: l.variantId,
            batchId: p.batchId,
            ownerType: p.ownerType,
            vendorId: p.vendorId,
            qty: p.qty,
          });
        }
        await this.repo.updateLine(tx, id, l.variantId, { dispatchedQty: { increment: l.qty } });
      }
      if (moves.length === 0)
        throw new ValidationError([{ path: 'body.lines', message: 'nothing to dispatch' }]);
      const trNo = await this.deps.stockService.nextDocNo(tx, 'TR');
      const t = await this.repo.createTransfer(
        tx,
        {
          id: uuidv7(),
          trNo,
          restockRequestId: id,
          sourceWarehouseId: r.sourceWarehouseId,
          destWarehouseId: r.destWarehouseId,
          dispatchedBy: caller.userId,
          etaAt: input.etaAt === undefined ? null : new Date(input.etaAt),
        },
        trLines,
      );
      await this.deps.stockEngine.apply(tx, moves, {
        commandId: uuidv7(),
        kind: 'TRANSFER_OUT',
        refType: 'TRANSFER',
        refId: t.id,
        refNo: trNo,
        reason: `Transfer to ${r.destWarehouseId}`,
        actorUserId: caller.userId,
        requestId: caller.requestId,
        enforce: { access: caller.access },
      });
      await this.repo.updateRequest(tx, id, { status: 'IN_TRANSIT' });
      await this.deps.auditService.record(tx, actorOf(caller), {
        action: 'transfer.dispatched',
        targetType: 'transfer',
        targetId: t.id,
        after: { trNo, lines: trLines.length },
      });
      return t.id;
    });
    return this.transferView(caller, transferId);
  }

  /** Destination receives a transfer: IN_TRANSIT → QC hold (same batch / owner), with a CN. */
  async receive(
    caller: Caller,
    transferId: string,
    input: {
      lines: { lineNo: number; receivedQty: number; binId?: string | null }[];
      notes?: string | null;
      close?: boolean;
    },
  ) {
    await this.deps.runInTransaction(async (tx) => {
      const t = await this.repo.lockTransfer(tx, transferId);
      if (t === null) throw new NotFoundError('Transfer');
      caller.access.require('inventory.receive', t.destWarehouseId);
      if (t.status !== 'IN_TRANSIT' && t.status !== 'PARTIALLY_RECEIVED')
        throw this.state('The transfer is already closed');
      if (input.lines.length === 0 && input.close !== true)
        throw new ValidationError([
          { path: 'body.lines', message: 'add a received line or close the transfer' },
        ]);
      const moves: StockMove[] = [];
      const receiptLines = [];
      for (const r of input.lines) {
        const line = t.lines.find((l) => l.lineNo === r.lineNo);
        if (line === undefined)
          throw new ValidationError([
            { path: 'body.lines', message: `line ${String(r.lineNo)} is not on this transfer` },
          ]);
        if (r.receivedQty > line.qty - line.receivedQty)
          throw new ValidationError([
            {
              path: 'body.lines',
              message: `line ${String(r.lineNo)}: only ${String(line.qty - line.receivedQty)} left to receive`,
            },
          ]);
        if (r.receivedQty === 0) continue;
        const target = {
          warehouseId: t.destWarehouseId,
          variantId: line.variantId,
          batchId: line.batchId,
          binId: r.binId ?? null,
          ownerType: line.ownerType,
          vendorId: line.vendorId,
        };
        moves.push({
          type: 'TRANSFER_IN',
          from: 'IN_TRANSIT',
          to: 'QC_HOLD',
          qty: r.receivedQty,
          target,
        });
        receiptLines.push({
          lineNo: receiptLines.length + 1,
          variantId: line.variantId,
          batchId: line.batchId,
          binId: r.binId ?? null,
          qty: r.receivedQty,
          ownerType: line.ownerType,
          vendorId: line.vendorId,
          initialStatus: 'QC_HOLD' as const,
        });
        await this.repo.receiveTransferLine(tx, transferId, r.lineNo, r.receivedQty);
      }
      if (moves.length > 0) {
        const receipt = await this.deps.stockService.recordReceipt(tx, {
          warehouseId: t.destWarehouseId,
          sourceType: 'TRANSFER',
          transferId,
          restockRequestId: t.restockRequestId,
          notes: input.notes ?? null,
          receivedBy: caller.userId,
          lines: receiptLines,
        });
        await this.deps.stockEngine.apply(tx, moves, {
          commandId: uuidv7(),
          kind: 'TRANSFER_IN',
          refType: 'TRANSFER',
          refId: transferId,
          refNo: t.trNo,
          reason: `Receipt ${receipt.cnNo}`,
          actorUserId: caller.userId,
          requestId: caller.requestId,
          enforce: { access: caller.access },
        });
      }
      const after = await this.repo.transfer(transferId, tx);
      const remaining = (after?.lines ?? []).reduce((s, l) => s + (l.qty - l.receivedQty), 0);
      const done = remaining === 0 || input.close === true;
      await this.repo.updateTransfer(tx, transferId, {
        status: done ? 'RECEIVED' : 'PARTIALLY_RECEIVED',
        ...(done ? { receivedAt: new Date(), receivedBy: caller.userId } : {}),
      });
      if (t.restockRequestId !== null) {
        for (const r of input.lines) {
          const line = t.lines.find((l) => l.lineNo === r.lineNo);
          if (line !== undefined && r.receivedQty > 0)
            await this.repo.updateLine(tx, t.restockRequestId, line.variantId, {
              receivedQty: { increment: r.receivedQty },
            });
        }
        await this.repo.updateRequest(tx, t.restockRequestId, {
          status: done ? 'RECEIVED' : 'PARTIALLY_RECEIVED',
        });
      }
      await this.deps.auditService.record(tx, actorOf(caller), {
        action: 'transfer.received',
        targetType: 'transfer',
        targetId: transferId,
        after: {
          lines: input.lines,
          closedShort: input.close === true && remaining > 0 ? remaining : 0,
        },
        reason: input.notes ?? null,
      });
    });
    return this.transferView(caller, transferId);
  }

  /** Procurement receipt (stock receipt API with `restockRequestId`), inside its transaction. */
  // ── D-62 gate: the approved procurement request is the gate's purchase order ──

  /** Approved / partly received PROCUREMENT requests of a warehouse (PO dropdown). */
  openProcurement(q: { warehouseId: string; vendorId?: string; q?: string; limit: number }) {
    return this.repo.openProcurement(q);
  }

  /** One request (no lock). */
  procurement(id: string, tx?: Tx): Promise<RequestRow | null> {
    return this.repo.request(id, tx);
  }

  /**
   * The request row locked FOR UPDATE: serialises every gate quantity check against it
   * (wizard shipments, ASN match / convert) so two of them cannot take the same open qty.
   */
  lockProcurement(tx: Tx, id: string): Promise<RequestRow | null> {
    return this.repo.lockRequest(tx, id);
  }

  async applyProcurementReceipt(
    tx: Tx,
    requestId: string,
    warehouseId: string,
    lines: readonly { variantId: string; qty: number }[],
  ): Promise<void> {
    const r = await this.repo.lockRequest(tx, requestId);
    if (r === null) throw new NotFoundError('Restock request');
    if (r.type !== 'PROCUREMENT' || r.destWarehouseId !== warehouseId)
      throw new ValidationError([
        {
          path: 'body.restockRequestId',
          message: 'is not a procurement request for this warehouse',
        },
      ]);
    if (r.status !== 'APPROVED' && r.status !== 'PARTIALLY_RECEIVED')
      throw this.state('The request is not approved');
    for (const l of lines)
      if (r.lines.some((x) => x.variantId === l.variantId))
        await this.repo.updateLine(tx, requestId, l.variantId, {
          receivedQty: { increment: l.qty },
        });
    const after = await this.repo.request(requestId, tx);
    const open = (after?.lines ?? []).some(
      (l) => l.receivedQty < (l.approvedQty ?? l.requestedQty),
    );
    await this.repo.updateRequest(tx, requestId, {
      status: open ? 'PARTIALLY_RECEIVED' : 'RECEIVED',
    });
  }

  async transfers(
    caller: Caller,
    q: { status?: string; warehouseId?: string; direction?: 'in' | 'out' },
    p: Paging,
  ) {
    if (q.warehouseId !== undefined) caller.access.require('inventory.view', q.warehouseId);
    const after = decodeCursor(p.cursor)?.[0];
    const rows = await this.repo.transfers(caller.access.scope('inventory.view'), {
      ...q,
      ...(typeof after === 'string' ? { cursor: after } : {}),
      limit: p.limit,
    });
    const page = toPageResult(rows, { limit: p.limit }, (t) => [t.id]);
    const whs = await this.names(
      page.items.flatMap((t) => [t.sourceWarehouseId, t.destWarehouseId]),
    );
    return { ...page, items: page.items.map((t) => this.transferSummary(t, whs)) };
  }

  async transferView(caller: Caller, id: string) {
    const t = await this.repo.transfer(id);
    if (t === null) throw new NotFoundError('Transfer');
    if (!caller.access.can('inventory.view', t.sourceWarehouseId))
      caller.access.require('inventory.view', t.destWarehouseId);
    const [whs, levels] = await Promise.all([
      this.names([t.sourceWarehouseId, t.destWarehouseId]),
      this.deps.stockService.levelsFor(
        t.destWarehouseId,
        t.lines.map((l) => l.variantId),
      ),
    ]);
    const batches = await this.deps.stockService.batchNos(t.lines.map((l) => l.batchId));
    return {
      ...this.transferSummary(t, whs),
      lines: t.lines.map((l) => ({
        lineNo: l.lineNo,
        variantId: l.variantId,
        sku: levels.get(l.variantId)?.sku ?? null,
        name: levels.get(l.variantId)?.name ?? null,
        batchId: l.batchId,
        batchNo: batches.get(l.batchId) ?? null,
        ownerType: l.ownerType,
        qty: l.qty,
        receivedQty: l.receivedQty,
      })),
    };
  }

  // ── helpers ──

  private transferSummary(
    t: TransferRow,
    whs: Map<string, { id: string; name: string; code: string }>,
  ) {
    return {
      id: t.id,
      trNo: t.trNo,
      restockRequestId: t.restockRequestId,
      source: whs.get(t.sourceWarehouseId) ?? { id: t.sourceWarehouseId, name: null, code: null },
      destination: whs.get(t.destWarehouseId) ?? { id: t.destWarehouseId, name: null, code: null },
      status: t.status,
      dispatchedAt: t.dispatchedAt,
      etaAt: t.etaAt,
      receivedAt: t.receivedAt,
      units: t.lines.reduce((s, l) => s + l.qty, 0),
      receivedUnits: t.lines.reduce((s, l) => s + l.receivedQty, 0),
    };
  }

  private summaryView(r: RequestRow, whs: Map<string, { id: string; name: string; code: string }>) {
    return {
      id: r.id,
      requestNo: r.requestNo,
      type: r.type,
      typeLabel: r.type === 'PROCUREMENT' ? 'Procurement' : 'Warehouse transfer',
      destination: whs.get(r.destWarehouseId) ?? { id: r.destWarehouseId, name: null, code: null },
      source:
        r.sourceWarehouseId === null
          ? null
          : (whs.get(r.sourceWarehouseId) ?? { id: r.sourceWarehouseId, name: null, code: null }),
      requiredBy: ymd(r.requiredBy),
      periodMonth: ymd(r.periodMonth)?.slice(0, 7) ?? null,
      status: r.status,
      statusLabel: STATUS_LABEL[r.status] ?? r.status,
      products: r.lines.length,
      requestedPacks: r.lines.reduce((s, l) => s + l.requestedQty, 0),
      createdAt: r.createdAt,
    };
  }

  private async names(ids: readonly (string | null)[]) {
    const rows = await this.deps.warehousesService.findMany([
      ...new Set(ids.filter((x): x is string => x !== null)),
    ]);
    return new Map(rows.map((w) => [w.id, { id: w.id, name: w.name, code: w.code }]));
  }

  private assertShape(r: {
    type: string;
    sourceWarehouseId?: string | null;
    destWarehouseId: string;
    vendorId?: string | null;
    lines: { variantId: string }[];
  }) {
    if (r.type === 'TRANSFER' && (r.sourceWarehouseId ?? null) === null)
      throw new ValidationError([
        { path: 'body.sourceWarehouseId', message: 'choose the source warehouse' },
      ]);
    if (r.type === 'TRANSFER' && r.sourceWarehouseId === r.destWarehouseId)
      throw new ValidationError([
        { path: 'body.sourceWarehouseId', message: 'must differ from the destination' },
      ]);
    if (r.type === 'PROCUREMENT' && (r.vendorId ?? null) === null)
      throw new ValidationError([{ path: 'body.vendorId', message: 'choose the vendor' }]);
    if (new Set(r.lines.map((l) => l.variantId)).size !== r.lines.length)
      throw new ValidationError([{ path: 'body.lines', message: 'each product only once' }]);
  }

  private async transition(
    caller: Caller,
    id: string,
    key: string,
    from: readonly string[],
    to: RequestRow['status'],
    action: string,
    data: Record<string, unknown>,
  ) {
    await this.deps.runInTransaction(async (tx) => {
      const r = await this.mustLock(tx, caller, id, key);
      if (!from.includes(r.status))
        throw this.state(`The request is ${STATUS_LABEL[r.status] ?? r.status}`);
      await this.repo.updateRequest(tx, id, { status: to, ...data });
      await this.deps.auditService.record(tx, actorOf(caller), {
        action,
        targetType: 'restock_request',
        targetId: id,
      });
    });
    return this.view(caller, id);
  }

  private async mustLock(tx: Tx, caller: Caller, id: string, key: string) {
    const r = await this.repo.lockRequest(tx, id);
    if (r === null) throw new NotFoundError('Restock request');
    caller.access.require(key, r.destWarehouseId);
    return r;
  }

  private state(message: string) {
    return new ConflictError(message, { details: { reason: 'INVALID_STATE' } });
  }
}
