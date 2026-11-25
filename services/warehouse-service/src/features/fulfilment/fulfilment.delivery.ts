import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

import {
  AppError,
  ConflictError,
  ErrorCode,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@farmx/common/errors';
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
import type { FlowActor } from './fulfilment.flow.js';
import type { JsonInput, ShipmentRow } from './fulfilment.repository.js';
import { addDays, istDay, istStart, pct } from './fulfilment.rules.js';

type Reason = 'DISCREPANCY' | 'POD_MISSING' | 'OTP_LOCK' | 'REFUND_IN_PROGRESS';
const REASON_LABEL: Record<Reason, string> = {
  DISCREPANCY: 'Pending – quantity discrepancy',
  POD_MISSING: 'Awaiting driver receipt',
  OTP_LOCK: 'Delivered by override – second approval pending',
  REFUND_IN_PROGRESS: 'Shortage refund in progress',
};
const staff = (c: Caller): FlowActor => ({
  type: 'STAFF',
  id: c.userId,
  requestId: c.requestId,
  access: c.access,
});

/** Who delivers: a staff user (with grants) or a 3PL driver trip link (checked by dispatch). */
export type DeliveryActor = { kind: 'staff'; caller: Caller } | { kind: 'driver'; tripId: string };

/**
 * Delivery (D-57b Phase 4b, D-40): out for delivery → OTP; deliver with the customer's OTP + POD
 * (photos / signature, received quantities); override without OTP (second approval later);
 * failed / reattempt / return to warehouse; fulfil (final quantities) with the prepaid settlement
 * status (W3.10). The OTP is HMAC-checked in constant time, stored AES-GCM-encrypted for the
 * customer app only, 5 tries, 12 h — never logged, evented or returned to staff.
 */
export class FulfilmentDelivery {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'fulfilmentRepository'
      | 'fulfilmentReadRepository'
      | 'shipmentFlow'
      | 'fulfilmentSettings'
      | 'fulfilmentExceptions'
      | 'mediaClient'
      | 'orderClient'
      | 'config'
      | 'runInTransaction'
      | 'auditService'
      | 'warehousesService'
      | 'dispatchService'
    >,
  ) {}

  private get repo() {
    return this.deps.fulfilmentRepository;
  }

  // ── OTP crypto ──

  private keys() {
    const secret = this.deps.config.DELIVERY_OTP_KEY ?? this.deps.config.INTERNAL_SERVICE_TOKEN;
    if (secret === undefined)
      throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, 'Delivery OTP is not configured', 503);
    const derive = (info: string) =>
      Buffer.from(hkdfSync('sha256', secret, 'farmx-delivery-otp', info, 32));
    return { hmac: derive('hmac'), aes: derive('aes') };
  }

  private digest(shipmentId: string, otp: string) {
    return createHmac('sha256', this.keys().hmac).update(`${shipmentId}:${otp}`).digest('hex');
  }

  private encrypt(otp: string) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.keys().aes, iv);
    const ct = Buffer.concat([c.update(otp, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }

  private decrypt(enc: string): string | null {
    try {
      const buf = Buffer.from(enc, 'base64');
      const d = createDecipheriv('aes-256-gcm', this.keys().aes, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  private async issueOtp(tx: Tx, s: ShipmentRow, resend: boolean) {
    const ttl = await this.deps.fulfilmentSettings.get('fulfilment.otpTtlHours', s.warehouseId);
    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.repo.saveOtp(tx, s.id, {
      otpHmac: this.digest(s.id, otp),
      otpEnc: this.encrypt(otp),
      expiresAt: new Date(Date.now() + ttl * 3_600_000),
      resend,
    });
  }

  // ── out for delivery / OTP ──

  async outForDelivery(actor: DeliveryActor, shipmentId: string) {
    await this.deps.runInTransaction(async (tx) => {
      const s = await this.lock(tx, actor, shipmentId, 'logistics.dispatch_assign');
      if (s.status !== 'DISPATCHED' && s.status !== 'DELIVERY_FAILED')
        throw new ConflictError(`A ${s.status} shipment cannot go out for delivery`, {
          details: { reason: 'INVALID_STATE' },
        });
      await this.issueOtp(tx, s, false);
      await this.deps.shipmentFlow.move(
        tx,
        s,
        'OUT_FOR_DELIVERY',
        this.flowActor(actor),
        'OUT_FOR_DELIVERY',
      );
    });
    return this.state(shipmentId);
  }

  async resendOtp(caller: Caller, shipmentId: string) {
    await this.deps.runInTransaction(async (tx) => {
      const s = await this.lock(
        tx,
        { kind: 'staff', caller },
        shipmentId,
        'logistics.dispatch_assign',
      );
      if (s.status !== 'OUT_FOR_DELIVERY')
        throw new ConflictError('The shipment is not out for delivery', {
          details: { reason: 'INVALID_STATE' },
        });
      const o = await this.repo.lockOtp(tx, s.id);
      const set = await this.deps.fulfilmentSettings.all(s.warehouseId);
      if (o !== null) {
        if (Date.now() - o.lastSentAt.getTime() < set['fulfilment.otpResendCooldownSec'] * 1000)
          throw new ConflictError('Wait before sending a new code', {
            details: { reason: 'OTP_COOLDOWN' },
          });
        if (o.resendCount >= set['fulfilment.otpMaxResends'])
          throw new ConflictError('No more codes can be sent; use the override', {
            details: { reason: 'OTP_RESEND_LIMIT' },
          });
      }
      await this.issueOtp(tx, s, true);
      await this.deps.shipmentFlow.note(tx, s, 'OTP_RESENT', staff(caller), null);
    });
    return { resent: true, deliveredVia: 'IN_APP' };
  }

  /** Checks the code in its own tx so a wrong attempt is counted even though the call fails. */
  private async verifyOtp(shipmentId: string, otp: string, maxAttempts: number) {
    const outcome = await this.deps.runInTransaction(async (tx) => {
      const o = await this.repo.lockOtp(tx, shipmentId);
      if (o === null) return 'NOT_ISSUED' as const;
      if (o.lockedAt !== null) return 'LOCKED' as const;
      if (o.expiresAt.getTime() < Date.now()) return 'EXPIRED' as const;
      const a = Buffer.from(this.digest(shipmentId, otp), 'hex');
      const b = Buffer.from(o.otpHmac, 'hex');
      if (a.length === b.length && timingSafeEqual(a, b)) return 'OK' as const;
      const attempts = o.attempts + 1;
      await this.repo.updateOtp(tx, shipmentId, {
        attempts,
        ...(attempts >= maxAttempts ? { lockedAt: new Date() } : {}),
      });
      return attempts >= maxAttempts ? ('LOCKED' as const) : ('INVALID' as const);
    });
    if (outcome === 'OK') return;
    if (outcome === 'NOT_ISSUED')
      throw new ConflictError('No delivery code was issued; mark it out for delivery first', {
        details: { reason: 'OTP_NOT_ISSUED' },
      });
    if (outcome === 'LOCKED')
      throw new AppError(ErrorCode.CONFLICT, 'Too many wrong codes; use the override', 423, {
        details: { reason: 'OTP_LOCKED' },
      });
    if (outcome === 'EXPIRED')
      throw new AppError(ErrorCode.CONFLICT, 'The delivery code expired; send a new one', 410, {
        details: { reason: 'OTP_EXPIRED' },
      });
    throw new ValidationError(
      [{ path: 'body.otp', message: 'is not correct' }],
      'Wrong delivery code',
    );
  }

  // ── deliver ──

  /** OTP + POD. Received quantities default to everything dispatched. */
  async deliver(
    actor: DeliveryActor,
    shipmentId: string,
    input: {
      otp: string;
      receiverName: string;
      receivedLines?: { lineNo: number; qty: number }[];
      podReceipts?: string[];
      signatureReceipt?: string | null;
      lat?: number | null;
      lng?: number | null;
    },
  ) {
    const pre = await this.repo.shipment(shipmentId);
    if (pre === null) throw new NotFoundError('Shipment');
    if (actor.kind === 'staff')
      actor.caller.access.require('logistics.delivery_confirm', pre.warehouseId);
    if (pre.status !== 'OUT_FOR_DELIVERY')
      throw new ConflictError(`A ${pre.status} shipment cannot be delivered`, {
        details: { reason: 'INVALID_STATE' },
      });
    const max = await this.deps.fulfilmentSettings.get(
      'fulfilment.otpMaxAttempts',
      pre.warehouseId,
    );
    await this.verifyOtp(shipmentId, input.otp, max);
    const media = this.media(actor, input.podReceipts ?? [], input.signatureReceipt ?? null);
    await this.deps.runInTransaction(async (tx) => {
      const s = await this.lock(tx, actor, shipmentId, 'logistics.delivery_confirm');
      if (s.status !== 'OUT_FOR_DELIVERY')
        throw new ConflictError('The shipment changed', { details: { reason: 'INVALID_STATE' } });
      await this.repo.updateOtp(tx, s.id, { verifiedAt: new Date() });
      await this.complete(tx, s, actor, {
        ...input,
        ...media,
        byOtp: true,
        otpVerifiedAt: new Date(),
      });
    });
    return this.state(shipmentId);
  }

  /** No OTP (customer phone dead, code locked …): reason; a second person approves in W3.10. */
  async deliverOverride(
    caller: Caller,
    shipmentId: string,
    input: {
      reason: string;
      receiverName: string;
      receivedLines?: { lineNo: number; qty: number }[];
      podReceipts?: string[];
      signatureReceipt?: string | null;
      lat?: number | null;
      lng?: number | null;
    },
  ) {
    const media = this.media(
      { kind: 'staff', caller },
      input.podReceipts ?? [],
      input.signatureReceipt ?? null,
    );
    await this.deps.runInTransaction(async (tx) => {
      const s = await this.lock(
        tx,
        { kind: 'staff', caller },
        shipmentId,
        'logistics.delivery_override',
      );
      if (s.status !== 'OUT_FOR_DELIVERY' && s.status !== 'DISPATCHED')
        throw new ConflictError(`A ${s.status} shipment cannot be delivered`, {
          details: { reason: 'INVALID_STATE' },
        });
      await this.complete(
        tx,
        s,
        { kind: 'staff', caller },
        { ...input, ...media, byOtp: false, otpVerifiedAt: null, overrideReason: input.reason },
      );
      await this.audit(
        tx,
        caller,
        'delivery.override',
        s.id,
        { receiverName: input.receiverName },
        input.reason,
      );
    });
    return this.state(shipmentId);
  }

  async failed(
    actor: DeliveryActor,
    shipmentId: string,
    input: { reason: string; note?: string | null },
  ) {
    await this.deps.runInTransaction(async (tx) => {
      const s = await this.lock(tx, actor, shipmentId, 'logistics.delivery_confirm');
      if (s.status !== 'OUT_FOR_DELIVERY' && s.status !== 'DISPATCHED')
        throw new ConflictError(`A ${s.status} shipment cannot fail delivery`, {
          details: { reason: 'INVALID_STATE' },
        });
      await this.deps.shipmentFlow.move(
        tx,
        s,
        'DELIVERY_FAILED',
        this.flowActor(actor),
        'DELIVERY_FAILED',
        {
          note: input.note ?? input.reason,
          data: {
            failedReason: input.reason.slice(0, 300),
            deliveryAttempts: s.deliveryAttempts + 1,
          },
        },
      );
      await this.deps.fulfilmentExceptions.raise(tx, {
        type: 'DELIVERY',
        cause: 'OTHER',
        severity: 'HIGH',
        warehouseId: s.warehouseId,
        orderId: s.orderId,
        shipmentId: s.id,
        title: `Delivery failed: ${input.reason}`.slice(0, 200),
        diagnostic: { attempt: s.deliveryAttempts + 1, note: input.note ?? null },
        proposal: { action: 'REATTEMPT_OR_RETURN' },
        dedupeKey: `delivery:${s.id}:${String(s.deliveryAttempts + 1)}`,
      });
    });
    return this.state(shipmentId);
  }

  /** Failed delivery comes back: units land in RETURNED (inspection then restocks them). */
  async returnToWarehouse(caller: Caller, shipmentId: string, input: { reason: string }) {
    await this.deps.runInTransaction(async (tx) => {
      const s = await this.lock(tx, { kind: 'staff', caller }, shipmentId, 'inventory.receive');
      if (s.status !== 'DELIVERY_FAILED')
        throw new ConflictError('Only a failed delivery can return', {
          details: { reason: 'INVALID_STATE' },
        });
      const issued = (await this.repo.allocations(s.id, tx)).filter((a) => a.status === 'ISSUED');
      await this.deps.shipmentFlow.stock(
        tx,
        s,
        issued.map((a) => ({
          type: 'RETURN' as const,
          from: 'DISPATCHED' as const,
          to: 'RETURNED' as const,
          qty: a.qty,
          target: { id: a.positionId },
          shipmentId: s.id,
        })),
        'RETURN',
        staff(caller),
        input.reason,
      );
      for (const a of issued)
        await this.repo.updateAllocation(tx, a.id, {
          status: 'RELEASED',
          releasedAt: new Date(),
          releaseReason: 'Returned to warehouse',
        });
      await this.deps.shipmentFlow.move(
        tx,
        s,
        'RETURNED_TO_WAREHOUSE',
        staff(caller),
        'RETURNED_TO_WAREHOUSE',
        { note: input.reason },
      );
      await this.audit(
        tx,
        caller,
        'delivery.returned',
        s.id,
        { units: issued.reduce((n, a) => n + a.qty, 0) },
        input.reason,
      );
    });
    return this.state(shipmentId);
  }

  /** Final quantities confirmed → FULFILLED with the settlement status (W3.10). */
  async fulfil(caller: Caller, shipmentId: string) {
    await this.deps.runInTransaction(async (tx) => {
      const s = await this.lock(tx, { kind: 'staff', caller }, shipmentId, 'fulfilment.manage');
      if (s.status !== 'DELIVERED')
        throw new ConflictError('Only a delivered shipment can be fulfilled', {
          details: { reason: 'INVALID_STATE' },
        });
      const reasons = await this.reasons(tx, s);
      await this.deps.shipmentFlow.move(tx, s, 'FULFILLED', staff(caller), 'FULFILLED', {
        data: {
          settlementStatus: reasons.length === 0 ? 'SETTLED' : 'PENDING',
          settlementReason: reasons[0] ?? null,
          ...(reasons.length === 0 ? { settledAt: new Date(), settledBy: caller.userId } : {}),
        },
      });
    });
    return this.state(shipmentId);
  }

  /** "Settle now": resolve the pending reason of a fulfilled prepaid shipment. */
  async settle(
    caller: Caller,
    shipmentId: string,
    input: {
      resolution: 'REFUND_SHORTAGE' | 'CONFIRM_FULL' | 'ATTACH_POD' | 'APPROVE_OVERRIDE';
      receipts?: string[];
      note?: string | null;
      expectedVersion: number;
    },
  ) {
    const s0 = await this.repo.shipment(shipmentId);
    if (s0 === null) throw new NotFoundError('Shipment');
    caller.access.require('fulfilment.manage', s0.warehouseId);
    if (s0.version !== input.expectedVersion)
      throw new ConflictError('The shipment changed', { details: { reason: 'VERSION_CONFLICT' } });
    if (s0.status !== 'FULFILLED' || s0.settlementStatus !== 'PENDING')
      throw new ConflictError('Nothing to settle', { details: { reason: 'INVALID_STATE' } });
    let refund: { sourceRef: string; amount: string } | null = null;
    if (input.resolution === 'REFUND_SHORTAGE') {
      const lines = s0.lines
        .filter((l) => l.dispatchedQty > l.deliveredQty && l.orderLineNo !== null)
        .map((l) => ({ lineNo: l.orderLineNo ?? 0, qty: l.dispatchedQty - l.deliveredQty }));
      if (lines.length === 0)
        throw new ConflictError('No shortage to refund', { details: { reason: 'NO_SHORTAGE' } });
      refund = await this.deps.orderClient.shortageRefund(s0.orderId, { shipmentId, lines });
    }
    const keys =
      input.resolution === 'ATTACH_POD'
        ? (input.receipts ?? []).map(
            (r, i) =>
              this.deps.mediaClient.verify(
                r,
                caller.userId,
                `body.receipts.${String(i)}`,
                'wms_document',
              ).key,
          )
        : [];
    if (input.resolution === 'ATTACH_POD' && keys.length === 0)
      throw new ValidationError([
        { path: 'body.receipts', message: 'attach at least one POD file' },
      ]);
    await this.deps.runInTransaction(async (tx) => {
      const s = await this.lock(tx, { kind: 'staff', caller }, shipmentId, 'fulfilment.manage');
      const pod = await this.repo.pod(s.id, tx);
      if (input.resolution === 'CONFIRM_FULL') {
        for (const l of s.lines)
          await this.repo.updateLine(tx, s.id, l.lineNo, { deliveredQty: l.dispatchedQty });
        if (pod !== null)
          await this.repo.updatePod(tx, s.id, {
            receivedLines: s.lines.map((l) => ({
              lineNo: l.lineNo,
              variantId: l.variantId,
              dispatched: l.dispatchedQty,
              delivered: l.dispatchedQty,
            })),
          });
      }
      if (input.resolution === 'ATTACH_POD' && pod !== null)
        await this.repo.updatePod(tx, s.id, { mediaKeys: [...pod.mediaKeys, ...keys] });
      if (input.resolution === 'APPROVE_OVERRIDE') {
        if (pod?.byOtp !== false)
          throw new ConflictError('This delivery was not an override', {
            details: { reason: 'NOT_OVERRIDE' },
          });
        if (!caller.access.can('logistics.delivery_override', s.warehouseId))
          throw new ForbiddenError();
        if (pod.overrideBy === caller.userId)
          throw new ForbiddenError(
            'Another person must approve the override (segregation of duties)',
          );
        await this.repo.updatePod(tx, s.id, {
          overrideApprovedBy: caller.userId,
          overrideApprovedAt: new Date(),
        });
      }
      const fresh = await this.repo.shipment(s.id, tx);
      const reasons = (await this.reasons(tx, fresh ?? s)).filter(
        (r) => !(input.resolution === 'REFUND_SHORTAGE' && r === 'DISCREPANCY'),
      );
      await this.repo.updateShipment(tx, s.id, {
        settlementStatus: reasons.length === 0 ? 'SETTLED' : 'PENDING',
        settlementReason: reasons[0] ?? null,
        ...(reasons.length === 0 ? { settledAt: new Date(), settledBy: caller.userId } : {}),
      });
      await this.deps.shipmentFlow.note(
        tx,
        s,
        `SETTLE_${input.resolution}`,
        staff(caller),
        input.note ?? null,
      );
      await this.audit(
        tx,
        caller,
        'delivery.settled',
        s.id,
        { resolution: input.resolution, refund, remaining: reasons },
        input.note ?? null,
      );
    });
    return { ...(await this.state(shipmentId)), refund };
  }

  // ── reads ──

  /**
   * D-61 print: the GST invoice PDF of ONE shipment for the gate copy. A shipment outside the
   * caller's warehouses answers 404 exactly like a missing one (no enumeration); before gate-out
   * there is no invoice (404 NO_INVOICE). Every print is audited.
   */
  async invoicePdf(caller: Caller, shipmentId: string) {
    const s = await this.repo.shipment(shipmentId);
    if (s === null || !caller.access.can('fulfilment.view', s.warehouseId))
      throw new NotFoundError('Shipment');
    const pdf = await this.deps.orderClient.shipmentInvoicePdf(s.orderId, s.id);
    if (pdf === null)
      throw new NotFoundError('Invoice', {
        details: { reason: 'NO_INVOICE', status: s.status },
      });
    await this.deps.runInTransaction((tx) =>
      this.audit(tx, caller, 'fulfilment.invoice_printed', s.id, {
        shipmentNo: s.shipmentNo,
        docNo: pdf.docNo,
      }),
    );
    return { file: pdf.file, fileName: `${pdf.docNo.replaceAll('/', '-') || s.shipmentNo}.pdf` };
  }

  /** W3.09 View POD: signed media, received quantities, OTP verified time (never the code). */
  async pod(caller: Caller, shipmentId: string) {
    const s = await this.repo.shipment(shipmentId);
    if (s === null) throw new NotFoundError('Shipment');
    caller.access.require('fulfilment.view', s.warehouseId);
    const pod = await this.repo.pod(s.id);
    if (pod === null) return { shipmentId, delivered: false };
    const keys = [
      ...pod.mediaKeys,
      ...(pod.signatureMediaKey === null ? [] : [pod.signatureMediaKey]),
    ];
    const urls = await this.deps.mediaClient.signRead(keys);
    const weigh = await this.deps.dispatchService.weighSlipOf(shipmentId);
    return {
      shipmentId,
      delivered: true,
      receiverName: pod.receiverName,
      receivedLines: pod.receivedLines,
      photos: pod.mediaKeys.map((k) => ({ key: k, url: urls[k] ?? null })),
      signature:
        pod.signatureMediaKey === null ? null : { url: urls[pod.signatureMediaKey] ?? null },
      location:
        pod.lat === null
          ? null
          : { lat: Number(pod.lat.toString()), lng: Number(pod.lng?.toString() ?? 0) },
      otp: pod.byOtp
        ? { verified: true, verifiedAt: pod.otpVerifiedAt }
        : { verified: false, verifiedAt: null },
      override: pod.byOtp
        ? null
        : {
            by: pod.overrideBy,
            reason: pod.overrideReason,
            approvedBy: pod.overrideApprovedBy,
            approvedAt: pod.overrideApprovedAt,
          },
      onTime: pod.onTime,
      deliveredVia: pod.deliveredVia,
      deliveredAt: pod.deliveredAt,
      weighSlip: weigh,
    };
  }

  async deliveredKpis(caller: Caller, warehouseId: string | undefined, from?: string, to?: string) {
    const scope = this.scope(caller, warehouseId);
    const t = to ?? istDay(new Date());
    const f = from ?? addDays(t, -29);
    const k = await this.deps.fulfilmentReadRepository.deliveredKpis(
      scope,
      warehouseId,
      istStart(f),
      new Date(istStart(t).getTime() + 86_400_000),
    );
    return {
      from: f,
      to: t,
      delivered: k.delivered,
      onTimeDeliveryPct: pct(k.onTime, k.delivered),
      podPct: pct(k.withPod, k.delivered),
      otpPct: pct(k.byOtp, k.delivered),
      failed: k.failed,
      returned: k.returned,
    };
  }

  async delivered(
    caller: Caller,
    f: {
      q?: string;
      from?: string;
      to?: string;
      customerId?: string;
      warehouseId?: string;
      status?: string;
    },
    p: Paging,
  ) {
    return this.page(
      caller,
      {
        ...f,
        statuses:
          f.status === undefined
            ? ['DELIVERED', 'DELIVERY_FAILED', 'RETURNED_TO_WAREHOUSE']
            : [f.status],
      },
      p,
    );
  }

  async fulfilledKpis(caller: Caller, warehouseId: string | undefined, month?: string) {
    const scope = this.scope(caller, warehouseId);
    const m = month ?? istDay(new Date()).slice(0, 7);
    const from = istStart(`${m}-01`);
    const next = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1));
    const days = await this.deps.fulfilmentSettings.get(
      'fulfilment.settleOverdueDays',
      warehouseId,
    );
    const k = await this.deps.fulfilmentReadRepository.fulfilledKpis(
      scope,
      warehouseId,
      from,
      istStart(next.toISOString().slice(0, 10)),
      new Date(Date.now() - days * 86_400_000),
    );
    return {
      month: m,
      settled: { count: k.settled, value: k.settledValue },
      pending: { count: k.pending, value: k.pendingValue },
      overdue: k.overdue,
      avgSettleHours: k.avgSettleHours === null ? null : Math.round(k.avgSettleHours * 10) / 10,
      tabs: [
        { key: 'all', label: 'All', count: k.total },
        { key: 'settled', label: 'Settled', count: k.settled },
        { key: 'pending', label: 'Pending', count: k.pending },
        { key: 'overdue', label: 'Overdue', count: k.overdue },
      ],
      overdueAfterDays: days,
      modules: { credit: false, invoice: false },
    };
  }

  async fulfilled(
    caller: Caller,
    f: { tab?: string; q?: string; month?: string; warehouseId?: string; settlementType?: string },
    p: Paging,
  ) {
    const days = await this.deps.fulfilmentSettings.get(
      'fulfilment.settleOverdueDays',
      f.warehouseId,
    );
    const m = f.month;
    return this.page(
      caller,
      {
        statuses: ['FULFILLED'],
        ...(f.q === undefined ? {} : { q: f.q }),
        ...(f.warehouseId === undefined ? {} : { warehouseId: f.warehouseId }),
        ...(m === undefined
          ? {}
          : {
              from: `${m}-01`,
              to: addDays(
                new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1))
                  .toISOString()
                  .slice(0, 10),
                -1,
              ),
            }),
        ...(f.tab === 'settled' || f.settlementType === 'SETTLED' ? { settlement: 'SETTLED' } : {}),
        ...(f.tab === 'pending' || f.settlementType === 'PENDING' ? { settlement: 'PENDING' } : {}),
        ...(f.tab === 'overdue' ? { overdueDays: days } : {}),
      },
      p,
    );
  }

  /** Customer app: own shipments; the OTP only while out for delivery. */
  async customerShipments(userId: string, orderId: string | undefined) {
    const rows = await this.deps.fulfilmentReadRepository.customerShipments(userId, orderId, 50);
    const out = [];
    for (const r of rows) {
      let otp: string | null = null;
      if (r.status === 'OUT_FOR_DELIVERY') {
        const o = await this.repo.otp(r.id);
        if (
          o !== null &&
          o.lockedAt === null &&
          o.verifiedAt === null &&
          o.expiresAt.getTime() > Date.now()
        )
          otp = this.decrypt(o.otpEnc);
      }
      const track =
        r.status === 'DISPATCHED' || r.status === 'OUT_FOR_DELIVERY'
          ? await this.deps.dispatchService.customerTracking(r.id)
          : null;
      out.push({
        shipmentId: r.id,
        orderId: r.orderId,
        orderNo: r.orderNo,
        status: r.status,
        units: r.unitCount,
        dispatchedAt: r.dispatchedAt,
        outForDeliveryAt: r.outForDeliveryAt,
        deliveredAt: r.deliveredAt,
        eta: track?.etaAt ?? null,
        tracking: track,
        deliveryOtp: otp,
      });
    }
    return out;
  }

  // ── exports (W3.09 POD archive, W3.09 / W3.10 CSV) ──

  async createExport(
    caller: Caller,
    input: {
      type: 'POD_ARCHIVE' | 'DELIVERED_CSV' | 'FULFILLED_CSV';
      filters?: Record<string, unknown>;
      shipmentIds?: string[];
    },
  ) {
    if (!caller.access.holdsAnywhere('fulfilment.view')) throw new ForbiddenError();
    const e = await this.deps.runInTransaction((tx) =>
      this.repo.createExport(tx, {
        type: input.type,
        filters: {
          ...(input.filters ?? {}),
          ...(input.shipmentIds === undefined ? {} : { shipmentIds: input.shipmentIds }),
        },
        requestedBy: caller.userId,
      }),
    );
    return { id: e.id, type: e.type, status: e.status, createdAt: e.createdAt };
  }

  async export(caller: Caller, id: string) {
    const e = await this.repo.export(id);
    if (e?.requestedBy !== caller.userId) throw new NotFoundError('Export');
    return {
      id: e.id,
      type: e.type,
      status: e.status,
      rowCount: e.rowCount,
      error: e.error,
      createdAt: e.createdAt,
      completedAt: e.completedAt,
      downloadable: e.status === 'READY',
    };
  }

  async exports(caller: Caller, cursor: string | undefined, limit: number) {
    const rows = await this.repo.exports(caller.userId, cursor, limit);
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null, limit };
  }

  /** CSV of a ready export; POD links are signed now (5-minute links from the download). */
  async *download(caller: Caller, id: string) {
    const e = await this.repo.export(id);
    if (e?.requestedBy !== caller.userId) throw new NotFoundError('Export');
    if (e.status !== 'READY')
      throw new ConflictError('The export is not ready', { details: { reason: 'NOT_READY' } });
    const rows = (e.rows ?? []) as Record<string, string | number | boolean | null | string[]>[];
    if (e.type === 'POD_ARCHIVE') {
      yield 'Shipment,Order,Customer,Delivered at,Receiver,OTP verified,Photo / signature links\n';
      for (let i = 0; i < rows.length; i += 50) {
        const chunk = rows.slice(i, i + 50);
        const urls = await this.deps.mediaClient.signRead(
          chunk.flatMap((r) => (r.mediaKeys as string[] | undefined) ?? []),
        );
        for (const r of chunk)
          yield `${[
            r.shipmentNo,
            r.orderNo,
            r.customer,
            r.deliveredAt,
            r.receiverName,
            r.otpVerified,
            ((r.mediaKeys as string[] | undefined) ?? []).map((k) => urls[k] ?? '').join(' '),
          ]
            .map((v) => csvCell(v as string | number | boolean | null))
            .join(',')}\n`;
      }
      return;
    }
    const cols = Object.keys(rows[0] ?? {});
    yield `${cols.join(',')}\n`;
    for (const r of rows)
      yield `${cols.map((c) => csvCell(r[c] as string | number | boolean | null)).join(',')}\n`;
  }

  /** exports-run job: builds queued exports (max 50k rows each). */
  async runExports() {
    const queued = await this.repo.queuedExports(5);
    for (const e of queued) {
      await this.repo.updateExport(e.id, { status: 'RUNNING' });
      try {
        const f = e.filters as Record<string, string | string[] | undefined>;
        const ids = Array.isArray(f.shipmentIds) ? f.shipmentIds : undefined;
        const statuses =
          e.type === 'FULFILLED_CSV'
            ? ['FULFILLED']
            : ['DELIVERED', 'FULFILLED', 'DELIVERY_FAILED', 'RETURNED_TO_WAREHOUSE'];
        const caller = { scope: 'ALL' as const };
        const rows: Record<string, unknown>[] = [];
        let after: unknown[] | null = null;
        for (;;) {
          const page = await this.deps.fulfilmentReadRepository.deliveryList(
            caller.scope,
            {
              statuses,
              ...(typeof f.warehouseId === 'string' ? { warehouseId: f.warehouseId } : {}),
              ...(typeof f.from === 'string' ? { from: istStart(f.from) } : {}),
              ...(typeof f.to === 'string'
                ? { to: new Date(istStart(f.to).getTime() + 86_400_000) }
                : {}),
            },
            { limit: 500, offset: null, after },
          );
          for (const r of page.slice(0, 500))
            if (ids === undefined || ids.includes(r.id))
              rows.push({ ...r, weightKg: r.weightKg.toString(), value: r.value.toString() });
          if (page.length <= 500 || rows.length >= 50_000) break;
          after = [page[499]?.id];
        }
        const pods =
          e.type === 'POD_ARCHIVE' ? await this.repo.podsOf(rows.map((r) => String(r.id))) : [];
        const built =
          e.type === 'POD_ARCHIVE'
            ? rows.map((r) => {
                const p = pods.find((x) => x.shipmentId === r.id);
                return {
                  shipmentNo: r.shipmentNo,
                  orderNo: r.orderNo,
                  customer: r.farmName ?? r.customerName,
                  deliveredAt: r.deliveredAt instanceof Date ? r.deliveredAt.toISOString() : null,
                  receiverName: p?.receiverName ?? null,
                  otpVerified: p?.byOtp ?? false,
                  mediaKeys: [
                    ...(p?.mediaKeys ?? []),
                    ...(p?.signatureMediaKey == null ? [] : [p.signatureMediaKey]),
                  ],
                };
              })
            : rows.map((r) => ({
                shipment: r.shipmentNo,
                order: r.orderNo,
                customer: r.farmName ?? r.customerName,
                status: r.status,
                dispatched: r.dispatched,
                delivered: r.delivered,
                deliveredAt: r.deliveredAt instanceof Date ? r.deliveredAt.toISOString() : null,
                settlement: r.settlementStatus,
                reason: r.settlementReason,
                value: r.value,
              }));
        await this.repo.updateExport(e.id, {
          status: 'READY',
          rows: built as JsonInput,
          rowCount: built.length,
          completedAt: new Date(),
        });
      } catch (err) {
        await this.repo.updateExport(e.id, {
          status: 'FAILED',
          error: (err instanceof Error ? err.message : 'failed').slice(0, 500),
          completedAt: new Date(),
        });
      }
    }
    return { processed: queued.length };
  }

  // ── internals ──

  private async complete(
    tx: Tx,
    s: ShipmentRow,
    actor: DeliveryActor,
    d: {
      receiverName: string;
      receivedLines?: { lineNo: number; qty: number }[];
      mediaKeys: string[];
      signatureKey: string | null;
      lat?: number | null;
      lng?: number | null;
      byOtp: boolean;
      otpVerifiedAt: Date | null;
      overrideReason?: string;
    },
  ) {
    const received = s.lines.map((l) => {
      const r = d.receivedLines?.find((x) => x.lineNo === l.lineNo);
      const qty = r?.qty ?? l.dispatchedQty;
      if (qty > l.dispatchedQty)
        throw new ValidationError([
          {
            path: 'body.receivedLines',
            message: `line ${String(l.lineNo)}: at most ${String(l.dispatchedQty)}`,
          },
        ]);
      return {
        lineNo: l.lineNo,
        variantId: l.variantId,
        dispatched: l.dispatchedQty,
        delivered: qty,
      };
    });
    for (const r of received)
      await this.repo.updateLine(tx, s.id, r.lineNo, { deliveredQty: r.delivered });
    const order = await this.repo.order(s.orderId, tx);
    const now = new Date();
    const promised =
      order?.promisedBy ??
      (s.slaDueAt === null ? null : new Date(s.slaDueAt.getTime() + 24 * 3_600_000));
    const onTime = promised === null ? null : now <= promised;
    await this.repo.createPod(tx, {
      shipmentId: s.id,
      receiverName: d.receiverName,
      receivedLines: received,
      mediaKeys: d.mediaKeys,
      signatureMediaKey: d.signatureKey,
      lat: d.lat == null ? null : d.lat.toFixed(6),
      lng: d.lng == null ? null : d.lng.toFixed(6),
      byOtp: d.byOtp,
      otpVerifiedAt: d.otpVerifiedAt,
      overrideBy: d.byOtp || actor.kind !== 'staff' ? null : actor.caller.userId,
      overrideReason: d.overrideReason ?? null,
      onTime,
      deliveredBy: actor.kind === 'staff' ? actor.caller.userId : null,
      deliveredVia: actor.kind === 'staff' ? 'STAFF' : 'DRIVER_LINK',
      deliveredAt: now,
    });
    await this.deps.shipmentFlow.move(
      tx,
      s,
      'DELIVERED',
      this.flowActor(actor),
      d.byOtp ? 'DELIVERED_OTP' : 'DELIVERED_OVERRIDE',
      {
        force: s.status === 'DISPATCHED',
        data: { deliveryAttempts: s.deliveryAttempts + 1 },
      },
    );
    if (onTime === true)
      await this.repo.bumpDaily(tx, s.warehouseId, istDay(now), { onTimeDelivery: 1 });
  }

  /** Pending settlement reasons, most important first. */
  private async reasons(tx: Tx, s: ShipmentRow): Promise<Reason[]> {
    const pod = await this.repo.pod(s.id, tx);
    const out: Reason[] = [];
    if (pod !== null && !pod.byOtp && pod.overrideApprovedBy === null) out.push('OTP_LOCK');
    if (s.lines.some((l) => l.deliveredQty < l.dispatchedQty)) out.push('DISCREPANCY');
    if (pod === null || (pod.mediaKeys.length === 0 && pod.signatureMediaKey === null))
      out.push('POD_MISSING');
    return out;
  }

  private async page(
    caller: Caller,
    f: {
      statuses: string[];
      q?: string;
      from?: string;
      to?: string;
      customerId?: string;
      warehouseId?: string;
      settlement?: string;
      overdueDays?: number;
    },
    p: Paging,
  ) {
    const scope = this.scope(caller, f.warehouseId);
    const offset = offsetOf(p);
    const { from, to, overdueDays, ...rest } = f;
    const filter = {
      ...rest,
      ...(from === undefined ? {} : { from: istStart(from) }),
      ...(to === undefined ? {} : { to: new Date(istStart(to).getTime() + 86_400_000) }),
      ...(overdueDays === undefined
        ? {}
        : { overdueBefore: new Date(Date.now() - overdueDays * 86_400_000) }),
    };
    const [rows, total] = await Promise.all([
      this.deps.fulfilmentReadRepository.deliveryList(scope, filter, {
        limit: p.limit,
        offset,
        after: decodeCursor(p.cursor),
      }),
      offset === null
        ? Promise.resolve(undefined)
        : this.deps.fulfilmentReadRepository.deliveryCount(scope, filter),
    ]);
    const page = toPageResult(rows, p, (r) => [r.id], total);
    return {
      ...page,
      items: page.items.map((r) => ({
        shipmentId: r.id,
        shipmentNo: r.shipmentNo,
        orderId: r.orderId,
        orderNo: r.orderNo,
        customer: r.farmName ?? r.customerName,
        district: r.district,
        status: r.status,
        dispatchedAt: r.dispatchedAt,
        deliveredAt: r.deliveredAt,
        fulfilledAt: r.fulfilledAt,
        receiverName: r.receiverName,
        otp:
          r.byOtp === null
            ? null
            : r.byOtp
              ? { verified: true, verifiedAt: r.otpVerifiedAt }
              : { verified: false, override: true, approved: r.overrideApproved },
        pod: { attached: (r.podMedia ?? 0) > 0, files: r.podMedia ?? 0 },
        onTime: r.onTime,
        failedReason: r.failedReason,
        attempts: r.deliveryAttempts,
        finalQty: {
          dispatched: r.dispatched,
          delivered: r.delivered,
          tonnes: Math.round(Number(r.weightKg.toString()) / 10) / 100,
        },
        valuation: {
          amount: r.value.toFixed(2),
          label:
            r.paymentInstrument === null
              ? 'Paid in advance'
              : `${r.paymentInstrument.toUpperCase()} · Paid in advance`,
        },
        settlement:
          r.settlementStatus === null
            ? null
            : {
                status: r.settlementStatus,
                reason: r.settlementReason,
                label:
                  r.settlementReason === null
                    ? 'Settled'
                    : REASON_LABEL[r.settlementReason as Reason],
                settledAt: r.settledAt,
              },
      })),
    };
  }

  private media(actor: DeliveryActor, receipts: readonly string[], signature: string | null) {
    if (actor.kind !== 'staff') return { mediaKeys: [], signatureKey: null };
    const uid = actor.caller.userId;
    return {
      mediaKeys: receipts.map(
        (r, i) =>
          this.deps.mediaClient.verify(r, uid, `body.podReceipts.${String(i)}`, 'wms_document').key,
      ),
      signatureKey:
        signature === null
          ? null
          : this.deps.mediaClient.verify(signature, uid, 'body.signatureReceipt', 'wms_document')
              .key,
    };
  }

  private flowActor(actor: DeliveryActor): FlowActor {
    return actor.kind === 'staff' ? staff(actor.caller) : { type: 'DRIVER', id: null };
  }

  private async lock(tx: Tx, actor: DeliveryActor, shipmentId: string, key: string) {
    const s = await this.repo.lockShipment(tx, shipmentId);
    if (s === null) throw new NotFoundError('Shipment');
    if (actor.kind === 'staff') actor.caller.access.require(key, s.warehouseId);
    return s;
  }

  private async state(shipmentId: string) {
    const s = await this.repo.shipment(shipmentId);
    if (s === null) throw new NotFoundError('Shipment');
    return {
      id: s.id,
      shipmentNo: s.shipmentNo,
      status: s.status,
      deliveredAt: s.deliveredAt,
      fulfilledAt: s.fulfilledAt,
      deliveryAttempts: s.deliveryAttempts,
      settlement:
        s.settlementStatus === null
          ? null
          : { status: s.settlementStatus, reason: s.settlementReason },
      lines: s.lines.map((l) => ({
        lineNo: l.lineNo,
        variantId: l.variantId,
        dispatched: l.dispatchedQty,
        delivered: l.deliveredQty,
      })),
      version: s.version,
    };
  }

  private scope(caller: Caller, warehouseId?: string) {
    if (warehouseId !== undefined) caller.access.require('fulfilment.view', warehouseId);
    return caller.access.scope('fulfilment.view');
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
        targetType: 'shipment',
        targetId: id,
        after: after as Record<string, unknown>,
        reason,
      },
    );
  }
}
