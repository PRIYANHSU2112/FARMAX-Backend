import { NotFoundError } from '@farmx/common/errors';
import type { Cradle } from '@fastify/awilix';

import type { Caller } from '../../middleware/guards.js';
import {
  type Paging,
  csvCell,
  decodeCursor,
  offsetOf,
  toPageResult,
} from '../../middleware/paging.js';
import type { LedgerRow, LedgerTab } from './payments-view.repository.js';

const IST_MS = 330 * 60_000;
const money = (v: string | null | undefined) => Number(v ?? 0).toFixed(2);
const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
const INSTRUMENT: Record<string, string> = {
  upi: 'UPI',
  netbanking: 'NetBanking',
  card: 'Card',
  wallet: 'Wallet',
  emi: 'EMI',
};

/** Month "YYYY-MM" in IST → [from, to). Default: this month. */
const monthRange = (month?: string) => {
  const now = new Date(Date.now() + IST_MS);
  const [y, m] =
    month === undefined
      ? [now.getUTCFullYear(), now.getUTCMonth() + 1]
      : (month.split('-').map(Number) as [number, number]);
  const from = new Date(Date.UTC(y, m - 1, 1) - IST_MS);
  const to = new Date(Date.UTC(y, m, 1) - IST_MS);
  return { month: `${String(y)}-${String(m).padStart(2, '0')}`, from, to };
};

/**
 * Payment view (D-57b W3.18). FarmX is prepaid only (no credit, no COD): every figure is a prepaid
 * order, its capture and its refunds. Credit-limit widgets answer `modules.credit: false`.
 */
export class PaymentsViewService {
  constructor(
    private readonly deps: Pick<Cradle, 'paymentsViewRepository' | 'paymentClient' | 'redis'>,
  ) {}

  private get repo() {
    return this.deps.paymentsViewRepository;
  }

  private scope(caller: Caller, warehouseId?: string) {
    if (warehouseId !== undefined) caller.access.require('fulfilment.view', warehouseId);
    return caller.access.scope('fulfilment.view');
  }

  async kpis(caller: Caller, warehouseId: string | undefined, month?: string) {
    const scope = this.scope(caller, warehouseId);
    const r = monthRange(month);
    const k = await this.repo.kpis(scope, warehouseId, r.from, r.to);
    const orders = k?.orders ?? 0;
    return {
      month: r.month,
      prepaidCleared: { orders: k?.paid ?? 0, value: money(k?.paidValue) },
      pendingPayment: { orders: k?.pending ?? 0, value: money(k?.pendingValue) },
      failedOrExpired: k?.failed ?? 0,
      refundClaims: {
        total: k?.refundClaims ?? 0,
        open: k?.refundOpen ?? 0,
        refunded: money(k?.refundedValue),
      },
      onHold: k?.held ?? 0,
      customers: k?.customers ?? 0,
      clearanceRatePct: pct(k?.paid ?? 0, orders),
      credit: null,
      modules: { credit: false, cod: false },
      asOf: new Date(),
    };
  }

  async orders(
    caller: Caller,
    f: { tab: LedgerTab; q?: string; warehouseId?: string; method?: string },
    p: Paging,
  ) {
    const scope = this.scope(caller, f.warehouseId);
    const offset = offsetOf(p);
    const rows = await this.repo.orders(scope, f, {
      limit: p.limit,
      offset,
      after: offset === null ? decodeCursor(p.cursor) : null,
    });
    const total = offset === null ? undefined : await this.repo.count(scope, f);
    const page = toPageResult(rows, p, (r) => [r.placedAt.toISOString(), r.orderId], total);
    const tabs = await this.repo.tabCounts(scope, f.warehouseId);
    return { ...page, items: page.items.map(view), tabs };
  }

  async customer(caller: Caller, userId: string) {
    const scope = this.scope(caller);
    const c = await this.repo.customer(scope, userId);
    if (c === undefined || c.orders === 0) throw new NotFoundError('Customer');
    const recent = await this.repo.orders(
      scope,
      { tab: 'all', userId },
      { limit: 5, offset: null, after: null },
    );
    return {
      userId,
      name: c.customerName,
      farmName: c.farmName,
      customerCode: c.farmCode,
      orders: c.orders,
      paidOrders: c.paid,
      paidValue: money(c.paidValue),
      refundedValue: money(c.refundedValue),
      refundClaims: c.refundClaims,
      firstOrderAt: c.firstOrderAt,
      lastOrderAt: c.lastOrderAt,
      paymentTerms: 'PREPAID',
      credit: null,
      modules: { credit: false },
      recentOrders: recent.slice(0, 5).map(view),
    };
  }

  /** Reconciliation SLA: capture clearance from payment-service (`modules.paymentStats`). */
  async sla(month?: string) {
    const r = monthRange(month);
    const s = await this.deps.paymentClient.stats(r.from, r.to);
    if (s === null) return { month: r.month, stats: null, modules: { paymentStats: false } };
    return {
      month: r.month,
      stats: {
        ...s,
        capturedValue: (s.capturedPaise / 100).toFixed(2),
        captureRatePct: pct(s.captured, s.created),
        within5MinPct: pct(s.within5Min, s.captured),
      },
      modules: { paymentStats: true },
    };
  }

  async *exportCsv(
    caller: Caller,
    f: { tab: LedgerTab; q?: string; warehouseId?: string; method?: string },
  ): AsyncGenerator<string> {
    const scope = this.scope(caller, f.warehouseId);
    yield 'order_no,placed_at,customer,customer_code,po_ref,amount,payment_status,instrument,reference,paid_at,refund_status,refunded,on_hold\n';
    let after: readonly unknown[] | null = null;
    for (;;) {
      const rows = await this.repo.orders(scope, f, { limit: 1000, offset: null, after });
      const batch = rows.slice(0, 1000);
      for (const r of batch.map(view))
        yield `${[
          r.orderNo,
          r.placedAt,
          r.customerName,
          r.customerCode,
          r.customerPoRef,
          r.amount,
          r.paymentStatus,
          r.valuation,
          r.reference,
          r.paidAt,
          r.refundStatus,
          r.refunded,
          r.onHold,
        ]
          .map((v) => csvCell(v))
          .join(',')}\n`;
      const last = batch.at(-1);
      if (rows.length <= 1000 || last === undefined) break;
      after = [last.placedAt.toISOString(), last.orderId];
    }
  }
}

const view = (r: LedgerRow) => ({
  orderId: r.orderId,
  orderNo: r.orderNo,
  userId: r.userId,
  customerName: r.customerName,
  farmName: r.farmName,
  customerCode: r.farmCode,
  customerPoRef: r.customerPoRef,
  amount: money(r.grandTotal),
  paymentStatus: r.paymentStatus,
  paymentMethod: r.paymentMethod,
  valuation:
    r.paymentInstrument === null
      ? 'Paid in advance'
      : `${INSTRUMENT[r.paymentInstrument.toLowerCase()] ?? r.paymentInstrument} • Paid in advance`,
  reference: r.paymentRefMasked,
  refundStatus: r.refundStatus ?? 'NONE',
  refunded: money(r.refunded),
  onHold: r.holdActive,
  orderStatus: r.orderStatus,
  terms: 'PREPAID',
  risk: null,
  placedAt: r.placedAt,
  paidAt: r.paidAt,
});
