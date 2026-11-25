import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';
import { emitWarehouseEvent } from '../../adapters/events.js';
import { bumpGateVersion } from '../../adapters/gate-version.js';
import { uuidv7 } from '../../adapters/uuid.js';
import type { Caller } from '../../middleware/guards.js';
import type { Actor } from '../audit/index.js';
import type { ApplyContext, StockMove } from './stock.engine.js';
import { projectionRow } from './stock.events.js';
import type { PositionRow } from './stock.repository.js';
import {
  COLUMN,
  FLOW_ONLY,
  OWNER_LABEL,
  type OwnerType,
  type StockStatus,
  type DocKind,
  docNo,
  fefoCompare,
  isColumn,
  periodOf,
  qrPrefix,
} from './stock.rules.js';
import type {
  AdjustmentInput,
  MoveInput,
  OwnerFixInput,
  ProposalDecision,
  ProposalInput,
  QualityInput,
  ReceiptInput,
  RelabelInput,
  StatusChangeInput,
  ThresholdInput,
} from './stock.types.js';

const actorOf = (c: Caller): Actor => ({ userId: c.userId, ip: c.ip, requestId: c.requestId });
const day = (s: string | null | undefined): Date | null =>
  s === undefined || s === null ? null : new Date(`${s}T00:00:00.000Z`);
const ymd = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));

const ctxOf = (
  c: Caller | null,
  kind: string,
  ref: { refType: string; refId: string | null; refNo: string | null; reason?: string | null },
  enforce: ApplyContext['enforce'],
): ApplyContext => ({
  commandId: uuidv7(),
  kind,
  refType: ref.refType,
  refId: ref.refId,
  refNo: ref.refNo,
  reason: ref.reason ?? null,
  actorUserId: c?.userId ?? null,
  requestId: c?.requestId ?? null,
  enforce,
});

/**
 * Stock commands (D-57a): interim inbound (receipt / CN, unit QR, COA, quality release / hold),
 * lifecycle status changes, bin moves, adjustments (maker-checker), owner fix, opening relabel,
 * thresholds (WMS-owned) and the lifecycle proposals. Every command = one transaction through
 * the stock engine + one audit row.
 */
export class StockService {
  private readonly repo: Cradle['stockRepository'];
  private readonly engine: Cradle['stockEngine'];
  private readonly settings: Cradle['stockSettings'];
  private readonly runInTransaction: Cradle['runInTransaction'];
  private readonly auditService: Cradle['auditService'];
  private readonly mediaClient: Cradle['mediaClient'];
  private readonly productClient: Cradle['productClient'];
  private readonly lazy: Pick<
    Cradle,
    | 'warehousesService'
    | 'storageService'
    | 'restockService'
    | 'stockQuality'
    | 'gateEntries'
    | 'redis'
  >;

  constructor(
    deps: Pick<
      Cradle,
      | 'stockRepository'
      | 'stockEngine'
      | 'stockSettings'
      | 'runInTransaction'
      | 'auditService'
      | 'mediaClient'
      | 'productClient'
      | 'warehousesService'
      | 'storageService'
      | 'restockService'
      | 'stockQuality'
      | 'gateEntries'
      | 'redis'
    >,
  ) {
    this.repo = deps.stockRepository;
    this.engine = deps.stockEngine;
    this.settings = deps.stockSettings;
    this.runInTransaction = deps.runInTransaction;
    this.auditService = deps.auditService;
    this.mediaClient = deps.mediaClient;
    this.productClient = deps.productClient;
    this.lazy = deps;
  }

  // ── Receive stock (CN) ──

  async receive(caller: Caller, input: ReceiptInput, idempotencyKey: string) {
    await this.lazy.warehousesService.requireVisible(
      caller,
      input.warehouseId,
      'inventory.receive',
    );
    const existing = await this.repo.receiptByKey(idempotencyKey);
    if (existing !== null) return this.receiptView(existing.id);
    const variants = new Map(
      (await this.ensureVariants(input.lines.map((l) => l.variantId))).map((v) => [v.variantId, v]),
    );
    const issues = input.lines.flatMap((l, i) =>
      variants.get(l.variantId)?.isActive === true
        ? []
        : [{ path: `body.lines.${i}.variantId`, message: 'unknown or inactive SKU' }],
    );
    if (issues.length > 0) throw new ValidationError(issues);
    await this.assertBins(
      input.warehouseId,
      input.lines.map((l) => l.binId ?? null),
    );
    const s = await this.settings.all(input.warehouseId);
    const isReturn = input.sourceType === 'RETURN';
    const initial: StockStatus = isReturn
      ? 'RETURNED'
      : s['stock.qcOnReceipt']
        ? 'QC_HOLD'
        : 'AVAILABLE';
    const kind: DocKind = isReturn ? 'RT' : 'CN';
    const supply = await this.repo.vendorSupply(input.lines.map((l) => l.variantId));
    // D-60: SKUs with an active quality spec land in QC_HOLD (released only by quality-service).
    const policies = isReturn
      ? new Map<string, { holdOnReceipt: boolean; isActive: boolean }>()
      : await this.lazy.stockQuality.policies(input.lines.map((l) => l.variantId));
    const serializedCats = new Set(s['stock.serializedCategoryIds']);

    const { id, gateWarning } = await this.runInTransaction(async (tx) => {
      let gateWarning: { code: string; reason: string } | null = null;
      const cnNo = await this.nextDocNo(tx, kind);
      const receiptId = uuidv7();
      const moves: StockMove[] = [];
      const lines = [];
      for (const [i, l] of input.lines.entries()) {
        const vendorId = l.vendorId ?? input.vendorId ?? null;
        const sup = supply.find((x) => x.variantId === l.variantId && x.vendorId === vendorId);
        const ownerType: OwnerType = l.ownerType ?? sup?.ownershipModel ?? 'FARMX';
        const v = variants.get(l.variantId);
        if (v === undefined) throw new Error('validated SKU vanished');
        const serialize =
          sup?.requiresUnitQr === true || v.categoryPath.some((c) => serializedCats.has(c));
        const batch = await this.upsertBatch(tx, l, vendorId, serialize, i);
        const policy = policies.get(l.variantId);
        const lineStatus: StockStatus = isReturn
          ? initial
          : batch.qualityBlocked
            ? 'QUARANTINED'
            : policy?.isActive === true && policy.holdOnReceipt
              ? 'QC_HOLD'
              : initial;
        moves.push({
          type: isReturn ? 'RETURN' : 'RECEIPT',
          from: isReturn ? 'DELIVERED' : 'RECEIVED',
          to: lineStatus,
          qty: l.qty,
          target: {
            warehouseId: input.warehouseId,
            variantId: l.variantId,
            batchId: batch.id,
            binId: l.binId ?? null,
            ownerType,
            vendorId: ownerType === 'FARMX' ? null : vendorId,
          },
        });
        lines.push({
          lineNo: i + 1,
          variantId: l.variantId,
          batchId: batch.id,
          binId: l.binId ?? null,
          qty: l.qty,
          ownerType,
          vendorId,
          initialStatus: lineStatus,
        });
      }
      await this.repo.createReceipt(tx, {
        id: receiptId,
        cnNo,
        warehouseId: input.warehouseId,
        sourceType: isReturn ? 'RETURN' : 'VENDOR',
        vendorId: input.vendorId ?? null,
        restockRequestId: input.restockRequestId ?? null,
        notes: input.notes ?? null,
        idempotencyKey,
        receivedBy: caller.userId,
        lines,
      });
      await this.engine.apply(
        tx,
        moves,
        ctxOf(
          caller,
          isReturn ? 'RETURN' : 'RECEIPT',
          { refType: 'RECEIPT', refId: receiptId, refNo: cnNo },
          'system',
        ),
      );
      if (!isReturn && input.restockRequestId !== undefined && input.restockRequestId !== null)
        await this.lazy.restockService.applyProcurementReceipt(
          tx,
          input.restockRequestId,
          input.warehouseId,
          lines.map((l) => ({ variantId: l.variantId, qty: l.qty })),
        );
      await this.lazy.stockQuality.publishReceipt(tx, receiptId, caller.requestId);
      // D-62: the receipt always posts; the gate link is best effort (warning when skipped).
      if (input.gateEntryId !== undefined && input.gateEntryId !== null) {
        const link = await this.lazy.gateEntries.linkReceiptInTx(tx, caller, {
          gateEntryId: input.gateEntryId,
          receiptId,
          cnNo,
          warehouseId: input.warehouseId,
          vendorId: input.vendorId ?? null,
          finalForGate: input.finalForGate === true,
        });
        gateWarning = link.warning;
      }
      await this.auditService.record(tx, actorOf(caller), {
        action: isReturn ? 'stock.return_received' : 'stock.received',
        targetType: 'stock_receipt',
        targetId: receiptId,
        after: { cnNo, warehouseId: input.warehouseId, lines: lines.length },
      });
      return { id: receiptId, gateWarning };
    });
    if (input.gateEntryId !== undefined && input.gateEntryId !== null)
      await bumpGateVersion(this.lazy.redis, input.warehouseId);
    const view = await this.receiptView(id);
    return gateWarning === null ? view : { ...view, warnings: [gateWarning] };
  }

  async receiptView(id: string) {
    const r = await this.repo.receipt(id);
    if (r === null) throw new NotFoundError('Receipt');
    const [batches, variants] = await Promise.all([
      this.repo.batches(r.lines.map((l) => l.batchId)),
      this.repo.variants(r.lines.map((l) => l.variantId)),
    ]);
    const b = new Map(batches.map((x) => [x.id, x]));
    const v = new Map(variants.map((x) => [x.variantId, x]));
    return {
      id: r.id,
      cnNo: r.cnNo,
      warehouseId: r.warehouseId,
      sourceType: r.sourceType,
      vendorId: r.vendorId,
      restockRequestId: r.restockRequestId,
      notes: r.notes,
      receivedAt: r.receivedAt,
      receivedBy: r.receivedBy,
      lines: r.lines.map((l) => ({
        lineNo: l.lineNo,
        variantId: l.variantId,
        sku: v.get(l.variantId)?.sku ?? null,
        productName: v.get(l.variantId)?.name ?? null,
        batchId: l.batchId,
        batchNo: b.get(l.batchId)?.batchNo ?? null,
        expiryDate: ymd(b.get(l.batchId)?.expiryDate ?? null),
        binId: l.binId,
        qty: l.qty,
        ownerType: l.ownerType,
        ownership: OWNER_LABEL[l.ownerType],
        status: l.initialStatus,
      })),
    };
  }

  async receipts(caller: Caller, q: { warehouseId?: string; cursor?: string; limit: number }) {
    const scope = caller.access.scope('inventory.view');
    if (q.warehouseId !== undefined) caller.access.require('inventory.view', q.warehouseId);
    const rows = await this.repo.receipts(scope, q);
    const items = rows.slice(0, q.limit);
    return {
      items,
      nextCursor: rows.length > q.limit ? (items.at(-1)?.id ?? null) : null,
      limit: q.limit,
    };
  }

  // ── Unit QR ──

  async generateUnits(caller: Caller, batchId: string, warehouseId: string) {
    await this.lazy.warehousesService.requireVisible(caller, warehouseId, 'inventory.receive');
    const batch = await this.mustBatch(batchId);
    if ((await this.repo.countUnits(batchId, warehouseId)) > 0)
      throw new ConflictError('Unit QR labels already exist for this batch here', {
        details: { reason: 'QR_ALREADY_GENERATED' },
      });
    const [variant] = await this.repo.variants([batch.variantId]);
    return this.runInTransaction(async (tx) => {
      const positions = await this.repo.lockBatchPositions(tx, warehouseId, batchId);
      let seq = await this.repo.maxUnitSeq(tx, batchId);
      let total = 0;
      const prefix = qrPrefix(
        batch.batchNo,
        variant?.sku ?? 'SKU',
        await this.repo.batchNoShared(tx, batch.batchNo, batch.variantId),
      );
      for (const p of positions)
        for (const [status, col] of Object.entries(COLUMN) as [StockStatus, keyof PositionRow][]) {
          const qty = p[col] as number;
          if (qty <= 0) continue;
          await this.repo.generateUnits(tx, {
            prefix,
            from: seq + 1,
            qty,
            batchId,
            variantId: batch.variantId,
            warehouseId,
            binId: p.binId,
            ownerType: p.ownerType,
            status,
          });
          seq += qty;
          total += qty;
        }
      if (!batch.serialized) await this.repo.updateBatch(tx, batchId, { serialized: true });
      await this.auditService.record(tx, actorOf(caller), {
        action: 'stock.units_generated',
        targetType: 'stock_batch',
        targetId: batchId,
        after: { warehouseId, units: total },
      });
      return { batchId, warehouseId, generated: total, serialized: true };
    });
  }

  // ── Quality release / hold ──

  async release(caller: Caller, input: QualityInput) {
    const from = input.from ?? 'QC_HOLD';
    await this.lazy.warehousesService.requireVisible(caller, input.warehouseId, 'warehouse.view');
    // D-60: QC_HOLD of a SKU with a quality spec is released only by a W16.07 decision.
    if (from === 'QC_HOLD') {
      const batch = await this.mustBatch(input.batchId);
      if (await this.lazy.stockQuality.isHeld(batch.variantId))
        throw new ConflictError('Release this batch from Quality release (W16.07)', {
          details: { reason: 'RELEASE_VIA_QUALITY', batchId: input.batchId },
        });
    }
    return this.qualityMove(caller, input, from, 'AVAILABLE', 'QC_RELEASE', 'quality.released');
  }

  async hold(caller: Caller, input: QualityInput) {
    const to = input.to ?? 'QC_HOLD';
    if (input.reason === undefined)
      throw new ValidationError([{ path: 'body.reason', message: 'say why the stock is held' }]);
    await this.lazy.warehousesService.requireVisible(caller, input.warehouseId, 'warehouse.view');
    return this.qualityMove(
      caller,
      input,
      'AVAILABLE',
      to,
      to === 'QUARANTINED' ? 'QUARANTINE' : 'QC_HOLD',
      'quality.held',
    );
  }

  private async qualityMove(
    caller: Caller,
    input: QualityInput,
    from: StockStatus,
    to: StockStatus,
    type: StockMove['type'],
    action: string,
  ) {
    await this.mustBatch(input.batchId);
    return this.runInTransaction(async (tx) => {
      const positions = await this.repo.lockBatchPositions(
        tx,
        input.warehouseId,
        input.batchId,
        input.binId,
      );
      const col = COLUMN[from as keyof typeof COLUMN];
      const have = positions.reduce((s, p) => s + p[col], 0);
      const want = input.qty ?? have;
      if (want <= 0 || want > have)
        throw new ConflictError(`Only ${have} units are ${from.toLowerCase()} in this batch here`, {
          details: { reason: 'INSUFFICIENT_STOCK', available: have },
        });
      let left = want;
      const moves: StockMove[] = [];
      for (const p of positions) {
        const n = Math.min(left, p[col]);
        if (n <= 0) continue;
        moves.push({ type, from, to, qty: n, source: { id: p.id } });
        left -= n;
        if (left === 0) break;
      }
      const res = await this.engine.apply(
        tx,
        moves,
        ctxOf(
          caller,
          type,
          { refType: 'QUALITY', refId: input.batchId, refNo: null, reason: input.reason ?? null },
          {
            access: caller.access,
          },
        ),
      );
      await this.auditService.record(tx, actorOf(caller), {
        action,
        targetType: 'stock_batch',
        targetId: input.batchId,
        after: { warehouseId: input.warehouseId, from, to, qty: want },
        reason: input.reason ?? null,
      });
      return {
        batchId: input.batchId,
        warehouseId: input.warehouseId,
        from,
        to,
        qty: want,
        movements: res.movements,
      };
    });
  }

  // ── Generic lifecycle move (damage, quarantine release, restock returned, write-off …) ──

  async statusChange(caller: Caller, input: StatusChangeInput) {
    if (FLOW_ONLY.has(input.from) || FLOW_ONLY.has(input.to))
      throw new ConflictError(
        'Reserved / picked / packed / in-transit stock moves only through its flow',
        {
          details: { reason: 'TRANSITION_NOT_ALLOWED' },
        },
      );
    if (!isColumn(input.from))
      throw new ValidationError([
        { path: 'body.from', message: 'must be a status stock can sit in' },
      ]);
    const p = await this.mustPosition(caller, input.positionId, 'warehouse.view');
    return this.runInTransaction(async (tx) => {
      const type: StockMove['type'] =
        input.to === 'DAMAGED'
          ? 'DAMAGE'
          : input.to === 'QUARANTINED'
            ? 'QUARANTINE'
            : input.to === 'WRITTEN_OFF'
              ? 'WRITE_OFF'
              : input.from === 'RETURNED' && input.to === 'AVAILABLE'
                ? 'RESTOCK'
                : 'STATUS_CHANGE';
      const res = await this.engine.apply(
        tx,
        [{ type, from: input.from, to: input.to, qty: input.qty, source: { id: p.id } }],
        ctxOf(
          caller,
          type,
          { refType: 'STATUS', refId: p.id, refNo: null, reason: input.reason },
          {
            access: caller.access,
          },
        ),
      );
      await this.auditService.record(tx, actorOf(caller), {
        action: 'stock.status_changed',
        targetType: 'stock_position',
        targetId: p.id,
        after: { from: input.from, to: input.to, qty: input.qty },
        reason: input.reason,
      });
      return {
        positionId: p.id,
        from: input.from,
        to: input.to,
        qty: input.qty,
        movements: res.movements,
      };
    });
  }

  // ── Bin move (put-away / restock to shelf) ──

  async moveBin(caller: Caller, input: MoveInput) {
    const p = await this.mustPosition(caller, input.positionId, 'inventory.receive');
    await this.assertBins(p.warehouseId, [input.toBinId]);
    if (p.binId === input.toBinId)
      throw new ValidationError([{ path: 'body.toBinId', message: 'is the current bin' }]);
    const status = input.status ?? 'AVAILABLE';
    if (!isColumn(status) || FLOW_ONLY.has(status))
      throw new ValidationError([{ path: 'body.status', message: 'cannot move this status' }]);
    return this.runInTransaction(async (tx) => {
      const review = p.reviewFields.filter((f) => f !== 'bin');
      const res = await this.engine.apply(
        tx,
        [
          {
            type: 'BIN_MOVE',
            from: status,
            to: status,
            qty: input.qty,
            source: { id: p.id },
            target: {
              warehouseId: p.warehouseId,
              variantId: p.variantId,
              batchId: p.batchId,
              binId: input.toBinId,
              ownerType: p.ownerType,
              vendorId: p.vendorId,
              reviewFields: review,
            },
          },
        ],
        ctxOf(
          caller,
          'BIN_MOVE',
          { refType: 'MOVE', refId: p.id, refNo: null, reason: input.reason ?? null },
          'none',
        ),
      );
      await this.auditService.record(tx, actorOf(caller), {
        action: 'stock.bin_moved',
        targetType: 'stock_position',
        targetId: p.id,
        after: { toBinId: input.toBinId, qty: input.qty, status },
      });
      return { positionId: p.id, toBinId: input.toBinId, qty: input.qty, movements: res.movements };
    });
  }

  // ── Adjustments (count corrections; maker-checker above the threshold) ──

  async adjust(caller: Caller, input: AdjustmentInput, idempotencyKey: string) {
    await this.lazy.warehousesService.requireVisible(caller, input.warehouseId, 'inventory.adjust');
    const prior = await this.repo.adjustmentByKey(idempotencyKey);
    if (prior !== null) return this.adjustmentView(prior.id);
    const positions = new Map(
      (await this.repo.positionsByIds(input.lines.map((l) => l.positionId))).map((p) => [p.id, p]),
    );
    const issues = input.lines.flatMap((l, i) => {
      const p = positions.get(l.positionId);
      if (p?.warehouseId !== input.warehouseId)
        return [
          { path: `body.lines.${i}.positionId`, message: 'not a stock position of this warehouse' },
        ];
      if (!isColumn(l.status) || FLOW_ONLY.has(l.status))
        return [{ path: `body.lines.${i}.status`, message: 'cannot adjust this status' }];
      return [];
    });
    if (issues.length > 0) throw new ValidationError(issues);
    const total = input.lines.reduce((s, l) => s + Math.abs(l.delta), 0);
    const limit = await this.settings.get('stock.adjustApprovalUnits', input.warehouseId);
    const needsApproval = total > limit;
    const id = await this.runInTransaction(async (tx) => {
      const period = periodOf(new Date());
      const adjNo = docNo('ADJ', period, await this.repo.nextSeq(tx, 'ADJ', period));
      const adj = await this.repo.createAdjustment(tx, {
        adjNo,
        warehouseId: input.warehouseId,
        lines: input.lines,
        totalUnits: total,
        reasonCode: input.reasonCode,
        note: input.note ?? null,
        status: needsApproval ? 'PENDING_APPROVAL' : 'APPLIED',
        idempotencyKey,
        requestedBy: caller.userId,
        ...(needsApproval ? {} : { decidedBy: caller.userId, decidedAt: new Date() }),
      });
      if (!needsApproval) await this.applyAdjustment(tx, caller, adj.id, adjNo, input);
      await this.auditService.record(tx, actorOf(caller), {
        action: needsApproval ? 'stock.adjustment_requested' : 'stock.adjusted',
        targetType: 'stock_adjustment',
        targetId: adj.id,
        after: { adjNo, totalUnits: total, lines: input.lines },
        reason: input.note ?? input.reasonCode,
      });
      return adj.id;
    });
    return this.adjustmentView(id);
  }

  async decideAdjustment(
    caller: Caller,
    id: string,
    approve: boolean,
    note: string | null,
    version: number,
  ) {
    const adj = await this.repo.adjustment(id);
    if (adj === null) throw new NotFoundError('Adjustment');
    caller.access.require('inventory.adjust', adj.warehouseId);
    if (adj.status !== 'PENDING_APPROVAL')
      throw new ConflictError('The adjustment is already decided', {
        details: { reason: 'ALREADY_DECIDED' },
      });
    if (adj.requestedBy === caller.userId)
      throw new ForbiddenError(
        'A second person must approve an adjustment (segregation of duties)',
      );
    if (adj.version !== version)
      throw new ConflictError('The adjustment changed', {
        details: { reason: 'VERSION_CONFLICT' },
      });
    await this.runInTransaction(async (tx) => {
      const ok = await this.repo.decideAdjustment(tx, id, version, {
        status: approve ? 'APPLIED' : 'REJECTED',
        decidedBy: caller.userId,
        decidedAt: new Date(),
        decisionNote: note,
      });
      if (!ok)
        throw new ConflictError('The adjustment changed', {
          details: { reason: 'VERSION_CONFLICT' },
        });
      if (approve)
        await this.applyAdjustment(tx, caller, id, adj.adjNo, {
          warehouseId: adj.warehouseId,
          reasonCode: adj.reasonCode,
          lines: adj.lines as AdjustmentInput['lines'],
        });
      await this.auditService.record(tx, actorOf(caller), {
        action: approve ? 'stock.adjustment_approved' : 'stock.adjustment_rejected',
        targetType: 'stock_adjustment',
        targetId: id,
        reason: note,
      });
    });
    return this.adjustmentView(id);
  }

  private async applyAdjustment(
    tx: Tx,
    caller: Caller,
    id: string,
    adjNo: string,
    input: Pick<AdjustmentInput, 'warehouseId' | 'reasonCode' | 'lines'>,
  ) {
    const moves: StockMove[] = input.lines.map((l) =>
      l.delta > 0
        ? {
            type: 'ADJUSTMENT',
            from: 'RECEIVED',
            to: l.status,
            qty: l.delta,
            target: { id: l.positionId },
          }
        : {
            type: 'ADJUSTMENT',
            from: l.status,
            to: 'WRITTEN_OFF',
            qty: -l.delta,
            source: { id: l.positionId },
          },
    );
    await this.engine.apply(
      tx,
      moves,
      ctxOf(
        caller,
        'ADJUSTMENT',
        { refType: 'ADJUSTMENT', refId: id, refNo: adjNo, reason: input.reasonCode },
        'none',
      ),
    );
  }

  async adjustmentView(id: string) {
    const a = await this.repo.adjustment(id);
    if (a === null) throw new NotFoundError('Adjustment');
    return a;
  }

  async adjustments(
    caller: Caller,
    q: { warehouseId?: string; status?: string; cursor?: string; limit: number },
  ) {
    if (q.warehouseId !== undefined) caller.access.require('inventory.view', q.warehouseId);
    const rows = await this.repo.adjustments(caller.access.scope('inventory.view'), q);
    const items = rows.slice(0, q.limit);
    return {
      items,
      nextCursor: rows.length > q.limit ? (items.at(-1)?.id ?? null) : null,
      limit: q.limit,
    };
  }

  // ── Owner fix and opening relabel (data corrections) ──

  async fixOwner(caller: Caller, positionId: string, input: OwnerFixInput) {
    const p = await this.mustPosition(caller, positionId, 'inventory.adjust');
    if (input.ownerType !== 'FARMX' && (input.vendorId ?? null) === null)
      throw new ValidationError([
        { path: 'body.vendorId', message: 'vendor-owned stock needs the vendor' },
      ]);
    const vendorId = input.ownerType === 'FARMX' ? null : (input.vendorId ?? null);
    if (p.ownerType === input.ownerType && p.vendorId === vendorId)
      throw new ValidationError([{ path: 'body.ownerType', message: 'is already the owner' }]);
    return this.runInTransaction(async (tx) => {
      const [cur] = await this.repo.lockPositions(tx, [positionId]);
      if (cur === undefined) throw new NotFoundError('Stock position');
      const target = {
        warehouseId: cur.warehouseId,
        variantId: cur.variantId,
        batchId: cur.batchId,
        binId: cur.binId,
        ownerType: input.ownerType,
        vendorId,
        reviewFields: cur.reviewFields.filter((f) => f !== 'ownerType'),
      };
      const moves: StockMove[] = (Object.entries(COLUMN) as [StockStatus, keyof PositionRow][])
        .filter(([, col]) => (cur[col] as number) > 0)
        .map(([status, col]) => ({
          type: 'OWNER_FIX' as const,
          from: status,
          to: status,
          qty: cur[col] as number,
          source: { id: cur.id },
          target,
        }));
      if (moves.length === 0)
        throw new ConflictError('The position is empty', { details: { reason: 'EMPTY' } });
      await this.engine.apply(
        tx,
        moves,
        ctxOf(
          caller,
          'OWNER_FIX',
          { refType: 'OWNER', refId: cur.id, refNo: null, reason: input.reason },
          'none',
        ),
      );
      await this.auditService.record(tx, actorOf(caller), {
        action: 'stock.owner_fixed',
        targetType: 'stock_position',
        targetId: cur.id,
        before: { ownerType: cur.ownerType, vendorId: cur.vendorId },
        after: { ownerType: input.ownerType, vendorId },
        reason: input.reason,
      });
      return {
        positionId: cur.id,
        ownerType: input.ownerType,
        ownership: OWNER_LABEL[input.ownerType],
        vendorId,
      };
    });
  }

  async relabelOpening(caller: Caller, positionId: string, input: RelabelInput) {
    const p = await this.mustPosition(caller, positionId, 'inventory.receive');
    const batch = await this.mustBatch(p.batchId);
    if (!batch.isOpening)
      throw new ConflictError('Only opening-balance stock can be relabelled', {
        details: { reason: 'NOT_OPENING' },
      });
    await this.assertBins(
      p.warehouseId,
      input.splits.map((s) => s.binId ?? null),
    );
    const total = input.splits.reduce((s, x) => s + x.qty, 0);
    return this.runInTransaction(async (tx) => {
      const [cur] = await this.repo.lockPositions(tx, [positionId]);
      if (cur === undefined || cur.available < total)
        throw new ConflictError(`Only ${cur?.available ?? 0} available units can be relabelled`, {
          details: { reason: 'INSUFFICIENT_STOCK' },
        });
      const moves: StockMove[] = [];
      for (const [i, s] of input.splits.entries()) {
        const b = await this.upsertBatch(
          tx,
          { variantId: cur.variantId, ...s },
          batch.vendorId,
          batch.serialized,
          i,
        );
        moves.push({
          type: 'RELABEL',
          from: 'AVAILABLE',
          to: 'AVAILABLE',
          qty: s.qty,
          source: { id: cur.id },
          target: {
            warehouseId: cur.warehouseId,
            variantId: cur.variantId,
            batchId: b.id,
            binId: s.binId ?? cur.binId,
            ownerType: cur.ownerType,
            vendorId: cur.vendorId,
            reviewFields: cur.reviewFields.filter(
              (f) => f !== 'batch' && (s.binId ? f !== 'bin' : true),
            ),
          },
        });
      }
      await this.engine.apply(
        tx,
        moves,
        ctxOf(
          caller,
          'RELABEL',
          { refType: 'RELABEL', refId: cur.id, refNo: null, reason: input.reason },
          'none',
        ),
      );
      await this.auditService.record(tx, actorOf(caller), {
        action: 'stock.opening_relabelled',
        targetType: 'stock_position',
        targetId: cur.id,
        after: { splits: input.splits },
        reason: input.reason,
      });
      return { positionId: cur.id, relabelled: total, splits: input.splits.length };
    });
  }

  // ── Thresholds (WMS-owned, published one way to inventory) ──

  async threshold(caller: Caller, warehouseId: string, variantId: string) {
    caller.access.require('inventory.view', warehouseId);
    const t = await this.repo.threshold(warehouseId, variantId);
    return (
      t ?? { warehouseId, variantId, safetyStock: 0, reorderLevel: 0, targetStock: 0, version: 0 }
    );
  }

  async setThresholds(
    caller: Caller,
    warehouseId: string,
    rows: (ThresholdInput & { variantId: string })[],
  ) {
    await this.lazy.warehousesService.requireVisible(caller, warehouseId, 'warehouse.configure');
    const bad = rows.flatMap((r, i) =>
      r.targetStock > 0 && r.targetStock < r.reorderLevel
        ? [
            {
              path: `body.${i}.targetStock`,
              message: 'must be at least the minimum (reorder level)',
            },
          ]
        : [],
    );
    if (bad.length > 0) throw new ValidationError(bad);
    return this.runInTransaction(async (tx) => {
      const out = [];
      for (const r of rows) {
        const saved = await this.repo.upsertThreshold(tx, warehouseId, r, caller.userId);
        await emitWarehouseEvent(
          tx,
          'warehouse.thresholds_changed.v1',
          {
            warehouseId,
            variantId: r.variantId,
            safetyStock: saved.safetyStock,
            reorderLevel: saved.reorderLevel,
            targetStock: saved.targetStock,
            version: saved.version,
          },
          caller.requestId,
        );
        out.push(saved);
      }
      await this.auditService.record(tx, actorOf(caller), {
        action: 'stock.thresholds_set',
        targetType: 'stock_threshold',
        targetId: warehouseId,
        after: { rows },
      });
      return out;
    });
  }

  // ── Lifecycle (W4.11) ──

  async lifecycle() {
    const rows = await this.engine.transitions();
    return {
      journey: [
        'RECEIVED',
        'QC_HOLD',
        'AVAILABLE',
        'RESERVED',
        'PICKED',
        'PACKED',
        'DISPATCHED',
        'DELIVERED',
      ],
      sideStates: ['QUARANTINED', 'DAMAGED', 'EXPIRED', 'IN_TRANSIT', 'RETURNED', 'WRITTEN_OFF'],
      note: 'All modules use one shared stock status. Changes require the correct event and an authorised role.',
      transitions: rows.size,
    };
  }

  async transitions() {
    return [...(await this.engine.transitions()).values()].map((t) => ({
      from: t.fromStatus,
      to: t.toStatus,
      requiredEvent: t.requiredEvent,
      authorizedRole: t.roleLabel,
      permissionKey: t.permissionKey,
      systemOnly: t.systemOnly,
      isActive: t.isActive,
    }));
  }

  async propose(caller: Caller, input: ProposalInput) {
    if (!caller.access.holdsAnywhere('warehouse.configure')) throw new ForbiddenError();
    if (input.from === input.to)
      throw new ValidationError([{ path: 'body.to', message: 'must differ from "from"' }]);
    return this.runInTransaction(async (tx) => {
      const p = await this.repo.createProposal(tx, {
        fromStatus: input.from,
        toStatus: input.to,
        action: input.action ?? 'ADD',
        reasonEvent: input.reasonEvent,
        roleLabel: input.roleLabel ?? null,
        proposedBy: caller.userId,
      });
      await this.auditService.record(tx, actorOf(caller), {
        action: 'stock.lifecycle_proposed',
        targetType: 'stock_lifecycle',
        targetId: p.id,
        after: input,
      });
      return p;
    });
  }

  async proposals(q: { status?: string; cursor?: string; limit: number }) {
    const rows = await this.repo.proposals(q);
    const items = rows.slice(0, q.limit);
    return {
      items,
      nextCursor: rows.length > q.limit ? (items.at(-1)?.id ?? null) : null,
      limit: q.limit,
    };
  }

  async decideProposal(caller: Caller, id: string, approve: boolean, d: ProposalDecision) {
    const p = await this.repo.proposal(id);
    if (p === null) throw new NotFoundError('Proposal');
    if (p.status !== 'PENDING')
      throw new ConflictError('The proposal is already decided', {
        details: { reason: 'ALREADY_DECIDED' },
      });
    if (p.proposedBy === caller.userId)
      throw new ForbiddenError('Another person must decide a proposal (segregation of duties)');
    if (approve && p.action === 'ADD' && (d.permissionKey ?? null) === null)
      throw new ValidationError([
        { path: 'body.permissionKey', message: 'say which permission allows the move' },
      ]);
    const res = await this.runInTransaction(async (tx) => {
      const ok = await this.repo.decideProposal(
        tx,
        id,
        approve ? 'APPROVED' : 'REJECTED',
        caller.userId,
        d.note ?? null,
      );
      if (!ok)
        throw new ConflictError('The proposal changed', {
          details: { reason: 'VERSION_CONFLICT' },
        });
      if (approve)
        await this.repo.applyProposal(tx, {
          from: p.fromStatus,
          to: p.toStatus,
          add: p.action === 'ADD',
          requiredEvent: p.reasonEvent.slice(0, 120),
          roleLabel: (d.roleLabel ?? p.roleLabel ?? 'Authorized role').slice(0, 80),
          permissionKey: d.permissionKey ?? null,
        });
      await this.auditService.record(tx, actorOf(caller), {
        action: approve ? 'stock.lifecycle_approved' : 'stock.lifecycle_rejected',
        targetType: 'stock_lifecycle',
        targetId: id,
        after: { from: p.fromStatus, to: p.toStatus, action: p.action, ...d },
        reason: d.note ?? null,
      });
      return this.repo.proposal(id, tx);
    });
    this.engine.invalidate();
    return res;
  }

  // ── Settings (admin) ──

  async allSettings(scope = 'GLOBAL') {
    return this.settings.all(scope);
  }

  async setSettings(caller: Caller, values: Record<string, unknown>, scope = 'GLOBAL') {
    const forbidden = ['stock.writesMode', 'stock.cutover'].filter((k) => k in values);
    if (forbidden.length > 0)
      throw new ValidationError(
        forbidden.map((k) => ({ path: `body.${k}`, message: 'is changed only by the cutover' })),
      );
    await this.runInTransaction(async (tx) => {
      for (const [k, v] of Object.entries(values))
        await this.settings.set(tx, k as never, v, caller.userId, scope);
      await this.auditService.record(tx, actorOf(caller), {
        action: 'stock.settings_changed',
        targetType: 'stock_settings',
        targetId: scope,
        after: values,
      });
    });
    return this.settings.all(scope);
  }

  // ── helpers used by other features (restock, fulfilment) ──

  /** Next document number `<kind>-YYMM-####` (CN, RT, TR, RST …), inside the caller's tx. */
  async nextDocNo(tx: Tx, kind: DocKind): Promise<string> {
    const period = periodOf(new Date());
    return docNo(kind, period, await this.repo.nextSeq(tx, kind, period));
  }

  /** Available, thresholds, open inbound and suggested qty per SKU at one warehouse. */
  async levelsFor(warehouseId: string, variantIds: readonly string[]) {
    const rows = await this.repo.levels(warehouseId, variantIds);
    return new Map(
      rows.map((r) => {
        const goal = r.targetStock > 0 ? r.targetStock : r.reorderLevel;
        return [r.variantId, { ...r, suggested: Math.max(goal - r.available - r.inbound, 0) }];
      }),
    );
  }

  /** Projection rows only (no product-service call; safe inside event transactions). */
  variantRows(ids: readonly string[], tx?: Tx) {
    return this.repo.variants(ids, tx);
  }

  /** AVAILABLE lots of some SKUs at a warehouse in FEFO order (fulfilment W3.05). */
  async lotsFor(warehouseId: string, variantIds: readonly string[]) {
    return await this.repo.lots(warehouseId, variantIds);
  }

  async vendorNames(ids: readonly (string | null)[]) {
    const rows = await this.repo.vendorsByIds(ids.filter((x): x is string => x !== null));
    return new Map(rows.map((v) => [v.id, { id: v.id, code: v.code, name: v.name }]));
  }

  async batchNos(ids: readonly string[]) {
    const rows = await this.repo.batches(ids);
    return new Map(rows.map((b) => [b.id, b.batchNo]));
  }

  /** Batch number + expiry + certificate of some batches (fulfilment pick list, COA check). */
  async batchExpiries(ids: readonly string[]) {
    if (ids.length === 0) return [];
    const rows = await this.repo.batches([...new Set(ids)]);
    return rows.map((b) => ({
      id: b.id,
      batchNo: b.batchNo,
      expiryDate: b.expiryDate,
      certificateStatus: b.certificateStatus,
      coaRef: b.coaRef,
    }));
  }

  /**
   * FEFO picks of AVAILABLE stock (positions locked): binned lots only (a picker cannot find
   * unbinned opening stock), expired lots skipped, dated lots before "expiry unknown".
   * 409 INSUFFICIENT_STOCK (reason UNBINNED_STOCK when only unbinned stock would cover it).
   */
  async pickFefo(tx: Tx, warehouseId: string, variantId: string, qty: number) {
    const today = new Date(new Date().toISOString().slice(0, 10));
    const rows = await this.repo.lockAvailable(tx, warehouseId, variantId);
    const usable = rows
      .filter((p) => p.binId !== null && (p.expiryDate === null || p.expiryDate >= today))
      .sort(fefoCompare);
    const picks: {
      positionId: string;
      batchId: string;
      binId: string | null;
      ownerType: OwnerType;
      vendorId: string | null;
      qty: number;
    }[] = [];
    let left = qty;
    for (const p of usable) {
      if (left === 0) break;
      const take = Math.min(p.available, left);
      picks.push({
        positionId: p.id,
        batchId: p.batchId,
        binId: p.binId,
        ownerType: p.ownerType,
        vendorId: p.vendorId,
        qty: take,
      });
      left -= take;
    }
    if (left > 0) {
      const unbinned = rows.filter((p) => p.binId === null).reduce((n, p) => n + p.available, 0);
      throw new ConflictError(`Only ${String(qty - left)} of ${String(qty)} available to pick`, {
        details: {
          reason: unbinned >= left ? 'UNBINNED_STOCK' : 'INSUFFICIENT_STOCK',
          variantId,
          warehouseId,
          short: left,
        },
      });
    }
    return picks;
  }

  /** Receipt (CN) header + lines written by another command (transfer receive). */
  async recordReceipt(
    tx: Tx,
    r: {
      warehouseId: string;
      sourceType: 'TRANSFER' | 'RETURN' | 'VENDOR';
      transferId?: string | null;
      restockRequestId?: string | null;
      notes: string | null;
      receivedBy: string;
      lines: {
        lineNo: number;
        variantId: string;
        batchId: string;
        binId: string | null;
        qty: number;
        ownerType: OwnerType;
        vendorId: string | null;
        initialStatus: StockStatus;
      }[];
    },
  ): Promise<{ id: string; cnNo: string }> {
    if (r.lines.some((l) => l.binId !== null))
      await this.assertBins(
        r.warehouseId,
        r.lines.map((l) => l.binId),
      );
    const id = uuidv7();
    const cnNo = await this.nextDocNo(tx, r.sourceType === 'RETURN' ? 'RT' : 'CN');
    await this.repo.createReceipt(tx, {
      id,
      cnNo,
      warehouseId: r.warehouseId,
      sourceType: r.sourceType,
      transferId: r.transferId ?? null,
      restockRequestId: r.restockRequestId ?? null,
      notes: r.notes,
      idempotencyKey: `auto:${id}`,
      receivedBy: r.receivedBy,
      lines: r.lines,
    });
    await this.lazy.stockQuality.publishReceipt(tx, id, `receipt:${id}`);
    return { id, cnNo };
  }

  // ── helpers ──

  /** Projection rows; SKUs missing (facts published before the WMS existed) are fetched once. */
  /** D-62 gate: vendor facts (code, name, status) by id. */
  vendorFacts(ids: readonly string[]) {
    return this.repo.vendorsByIds(ids);
  }

  /** D-62 gate: product search (name / SKU) on the variant projection. */
  searchVariants(q: string, limit: number) {
    return this.repo.searchVariants(q, limit);
  }

  async ensureVariants(ids: readonly string[]) {
    const have = await this.repo.variants(ids);
    const missing = [...new Set(ids)].filter((id) => !have.some((v) => v.variantId === id));
    if (missing.length === 0) return have;
    const facts = await this.productClient.variantFacts(missing);
    if (facts === null || facts.length === 0) return have;
    await this.runInTransaction(async (tx) => {
      for (const f of facts) await this.repo.upsertVariant(tx, projectionRow(f));
    });
    return this.repo.variants(ids);
  }

  private async upsertBatch(
    tx: Tx,
    l: { variantId: string; batchNo: string; mfgDate?: string | null; expiryDate?: string | null },
    vendorId: string | null,
    serialize: boolean,
    index: number,
  ) {
    const batchNo = l.batchNo.trim().toUpperCase();
    const found = await this.repo.batchByNo(l.variantId, batchNo, tx);
    const expiry = day(l.expiryDate);
    if (found === null)
      return this.repo.createBatch(tx, {
        variantId: l.variantId,
        batchNo,
        mfgDate: day(l.mfgDate),
        expiryDate: expiry,
        vendorId,
        serialized: serialize,
      });
    if (found.expiryDate !== null && expiry !== null && ymd(found.expiryDate) !== ymd(expiry))
      throw new ConflictError(`Batch ${batchNo} is recorded with expiry ${ymd(found.expiryDate)}`, {
        details: { reason: 'BATCH_MISMATCH', line: index },
      });
    if (found.expiryDate === null && expiry !== null)
      return this.repo.updateBatch(tx, found.id, {
        expiryDate: expiry,
        mfgDate: day(l.mfgDate) ?? found.mfgDate,
      });
    if (serialize && !found.serialized)
      return this.repo.updateBatch(tx, found.id, { serialized: true });
    return found;
  }

  private async assertBins(warehouseId: string, binIds: readonly (string | null)[]) {
    const ids = binIds.filter((b): b is string => b !== null);
    if (ids.length === 0) return;
    const facts = await this.lazy.storageService.binFacts(ids);
    const bad = ids.filter(
      (id) => facts.get(id)?.warehouseId !== warehouseId || facts.get(id)?.status !== 'ACTIVE',
    );
    if (bad.length > 0)
      throw new ValidationError(
        bad.map((id) => ({
          path: 'body.binId',
          message: `bin ${id} is not an active bin of this warehouse`,
        })),
      );
  }

  private async mustBatch(id: string) {
    const b = await this.repo.batch(id);
    if (b === null) throw new NotFoundError('Batch');
    return b;
  }

  private async mustPosition(caller: Caller, id: string, key: string) {
    const p = await this.repo.position(id);
    if (p === null) throw new NotFoundError('Stock position');
    caller.access.require(key, p.warehouseId);
    return p;
  }
}
