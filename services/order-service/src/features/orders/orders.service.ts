import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '@farmx/common/errors';
import { toGstStateCode } from '@farmx/common/gst';
import type { AuthUser, Paginated } from '@farmx/common/types';
import { type Tx, isUniqueViolation } from '@farmx/database';
import { ORDER_EVENTS } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import { emitOrderEvent } from '../../adapters/events.js';
import {
  type AddressSnapshot,
  type PaymentCheckout,
  type Reservation,
  UpstreamRefusal,
} from '../../adapters/internal-clients.js';
import { uuidv7 } from '../../adapters/uuid.js';
import { requestHash } from '../../middleware/http.js';
import { fromBasisPoints, fromPaise, toPaise } from '../pricing/index.js';
import type { IssuedDocument, ShipmentRequest } from '../invoices/index.js';
import type { OrderLedgerView } from '../transactions/index.js';
import { toInvoiceFacts } from './orders.invoice-facts.js';
import type { Ctx } from './orders.lifecycle.js';
import {
  type CancelInput,
  type CheckoutInput,
  type OrderListQuery,
  type OrderRow,
  type OrderWithLines,
  SYSTEM,
  UNPAID_STATUSES,
} from './orders.types.js';
import {
  type OrderDetailView,
  type OrderSummaryView,
  toDetail,
  toSummary,
} from './orders.views.js';

type Deps = Pick<
  Cradle,
  | 'ordersRepository'
  | 'orderLifecycle'
  | 'runInTransaction'
  | 'cartService'
  | 'orderCancelService'
  | 'offersService'
  | 'promotionsService'
  | 'settingsService'
  | 'inventoryClient'
  | 'paymentClient'
  | 'walletClient'
  | 'transactionsService'
  | 'invoicesService'
  | 'addressClient'
  | 'logger'
>;

export interface CheckoutResult {
  order: OrderDetailView;
  /** Open the gateway checkout with this (null when nothing is payable). */
  payment: PaymentCheckout | null;
  replayed: boolean;
}

const STUCK_AFTER_MS = 2 * 60_000;
const GIVE_UP_AFTER_MS = 10 * 60_000;
const JOB_BATCH = 50;

const refusal = (message: string, reason: string, extra: object = {}) =>
  new ConflictError(message, { details: { reason, ...extra } });

/**
 * Checkout + order reads (D-34…D-44). Checkout is RESUMABLE: the order row is written first (one
 * transaction: cart lock, price, offers, order + lines + status event + outbox), then reserve and
 * the payment intent run in parallel (both idempotent by order id). Any interruption is resumed by
 * a retry with the same Idempotency-Key or by the stuck-orders job.
 */
export class OrdersService {
  constructor(private readonly deps: Deps) {}

  // ── Checkout ──

  async checkout(
    user: AuthUser,
    key: string,
    input: CheckoutInput,
    ctx: Ctx,
  ): Promise<CheckoutResult> {
    const hash = requestHash(input);
    const earlier = await this.deps.ordersRepository.findByKey(key);
    if (earlier !== null) return this.replay(user, earlier, hash, ctx);

    const settings = await this.deps.settingsService.current();
    const cart = await this.deps.cartService.checkoutSnapshot(user.id);
    if (cart === null || cart.lines.length === 0)
      throw new ValidationError([{ path: 'cart', message: 'is empty' }], 'Your cart is empty');
    if (cart.version !== input.cartVersion)
      throw refusal(
        'Your cart changed after the price was checked. Review it and try again.',
        'CART_CHANGED',
        {
          quotedVersion: input.cartVersion,
          currentVersion: cart.version,
        },
      );
    if (cart.lines.length > settings.maxOrderLines)
      throw new ValidationError([
        {
          path: 'cart.lines',
          message: `at most ${String(settings.maxOrderLines)} lines per order`,
        },
      ]);

    const [priced, address] = await Promise.all([
      this.deps.offersService.priceForCheckout(user, {
        farmId: input.farmId,
        lines: cart.lines,
        billToGst: input.billToGst,
        ...(cart.couponCode === null ? {} : { couponCode: cart.couponCode }),
      }),
      this.address(user.id, input.addressId),
    ]);
    const { result, farm, variants } = priced;
    this.checkSellable(cart.lines, variants, input.billToGst, farm.gstin);
    if (result.couponStatus !== null && !result.couponStatus.applied)
      throw new ValidationError(
        [{ path: 'cart.couponCode', message: result.couponStatus.message ?? 'not applicable' }],
        'The coupon in your cart cannot be applied; remove it or change the cart',
      );

    const inv = result.invoice;
    if (input.paymentMethod === 'WALLET') await this.checkWallet(user.id, inv.finalPayable);
    const orderId = uuidv7();
    const lineIds = result.lines.map(() => uuidv7());
    const factsById = new Map(variants.map((v) => [v.variantId, v]));
    const now = new Date();
    const paymentDueAt = new Date(now.getTime() + settings.paymentWindowMinutes * 60_000);
    const gstBilled = input.billToGst && farm.gstin !== null;

    try {
      await this.deps.runInTransaction(async (tx) => {
        // Same lock order as every cart write: cart → items → promotions.
        const { cartId } = await this.deps.cartService.lockForCheckoutInTx(
          tx,
          user.id,
          input.cartVersion,
        );
        // A second checkout of the same cart version now fails (no double order from one cart).
        await this.deps.cartService.touchInTx(tx, cartId);
        const orderNo = await this.deps.ordersRepository.nextOrderNo(tx, now);
        await this.deps.ordersRepository.create(
          tx,
          {
            id: orderId,
            orderNo,
            userId: user.id,
            farmId: farm.farmId,
            itemSubtotal: fromPaise(inv.itemSubtotal),
            discountTotal: fromPaise(
              inv.lineOfferDiscount + inv.couponDiscount + inv.autoBonusDiscount,
            ),
            taxableAmount: fromPaise(inv.taxableAmount),
            cgst: fromPaise(inv.cgst),
            sgst: fromPaise(inv.sgst),
            igst: fromPaise(inv.igst),
            freight: fromPaise(inv.freight),
            freightDiscount: fromPaise(inv.freightDiscount),
            grandTotal: fromPaise(inv.finalPayable),
            priceTrace: JSON.parse(JSON.stringify(result)) as object,
            billing: {
              farmId: farm.farmId,
              farmCode: farm.farmCode,
              name: farm.name,
              gstin: gstBilled ? farm.gstin : null,
              itcEligible: gstBilled,
              // Addresses carry the 2-letter state ("AP"); tax documents need the GST code ("37").
              placeOfSupply: toGstStateCode(address.stateCode) ?? address.stateCode,
              interState: inv.interState,
            },
            deliveryAddress: { ...address },
            couponCode: cart.couponCode,
            cartVersion: cart.version,
            paymentMethod: input.paymentMethod,
            idempotencyKey: key,
            requestHash: hash,
            placedAt: now,
            paymentDueAt,
          },
          result.lines.map((l, i) => ({
            id: lineIds[i] ?? uuidv7(),
            lineNo: i + 1,
            variantId: l.variantId,
            productId: factsById.get(l.variantId)?.productId ?? l.variantId,
            sku: l.sku,
            name: l.name,
            hsnCode: l.hsnCode,
            gstRate: fromBasisPoints(l.gstRate),
            temperatureClass: factsById.get(l.variantId)?.temperatureClass ?? 'AMB',
            qty: l.qty,
            unitPrice: fromPaise(l.unitPrice),
            lineGross: fromPaise(l.lineGross),
            lineDiscount: fromPaise(l.lineOfferDiscount + l.couponDiscount + l.autoBonusDiscount),
            taxableValue: fromPaise(l.taxableValue),
            cgst: fromPaise(l.cgst),
            sgst: fromPaise(l.sgst),
            igst: fromPaise(l.igst),
            lineTotal: fromPaise(l.lineTotal),
            allocations: l.allocations.map((a) => ({
              promotionId: a.promotionId,
              amount: fromPaise(a.amount),
            })),
          })),
        );
        await this.deps.promotionsService.redeemInTx(tx, {
          orderId,
          farmId: farm.farmId,
          userId: user.id,
          redemptions: result.applied.map((a) => ({
            promotionId: a.promotionId,
            discountAmount: fromPaise(a.discount),
            items: result.lines.flatMap((l, i) =>
              l.allocations
                .filter((x) => x.promotionId === a.promotionId && x.amount > 0)
                .map((x) => ({
                  orderItemId: lineIds[i] ?? '',
                  quantity: l.qty,
                  discountAmount: fromPaise(x.amount),
                })),
            ),
          })),
        });
        await this.deps.ordersRepository.addEvents(
          tx,
          orderId,
          { type: 'CUSTOMER', id: user.id },
          [{ field: 'STATUS', from: null, to: 'PENDING_ADMIN_CONFIRMATION' }],
          { code: 'PLACED' },
        );
        await emitOrderEvent(
          tx,
          ORDER_EVENTS.placed,
          {
            orderId,
            orderNo,
            userId: user.id,
            farmId: farm.farmId,
            grandTotal: fromPaise(inv.finalPayable),
            paymentDueAt: paymentDueAt.toISOString(),
            // Warehouse operations list (D-56): who and where, no phone or street address.
            shipTo: {
              name: address.contactName,
              district: address.district,
              pinCode: address.pinCode,
            },
          },
          ctx.correlationId,
        );
      });
    } catch (error) {
      // Same key raced in from a double tap: the other request owns the order now.
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.deps.ordersRepository.findByKey(key);
      if (raced === null) throw error;
      return this.replay(user, raced, hash, ctx);
    }
    const order = await this.mustFind(orderId);
    return { ...(await this.advance(order, ctx)), replayed: false };
  }

  /** Same Idempotency-Key: same buyer + same body → continue where it stopped. */
  private async replay(user: AuthUser, order: OrderWithLines, hash: string, ctx: Ctx) {
    if (order.userId !== user.id || order.requestHash !== hash)
      throw new ValidationError(
        [{ path: 'headers.idempotency-key', message: 'already used for a different request' }],
        'Idempotency-Key reused with a different request',
      );
    return { ...(await this.advance(order, ctx)), replayed: true };
  }

  /**
   * Moves a placed order forward: reserve stock (if still unknown) and get the payment intent
   * (if payable), in parallel. Both calls are idempotent by order id.
   */
  async advance(order: OrderWithLines, ctx: Ctx): Promise<Omit<CheckoutResult, 'replayed'>> {
    const open = order.status === 'PENDING_ADMIN_CONFIRMATION';
    const needsStock = open && order.stockStatus === 'PENDING';
    const payable =
      open &&
      UNPAID_STATUSES.includes(order.paymentStatus) &&
      order.paymentDueAt.getTime() > Date.now() &&
      ['PENDING', 'RESERVED', 'COMMITTED'].includes(order.stockStatus);
    if (!needsStock && !payable) return { order: await this.detail(order), payment: null };

    const settings = await this.deps.settingsService.current();
    const [stock, payment] = await Promise.allSettled([
      needsStock
        ? this.reserve(order, settings.paymentWindowMinutes, settings.paymentGraceSeconds)
        : null,
      payable ? this.createPayment(order) : null,
    ]);

    if (stock.status === 'rejected') {
      const err: unknown = stock.reason;
      if (err instanceof UpstreamRefusal && err.status < 500) {
        // R1: no stock (or not serviceable) → FAILED; the parallel payment intent is voided by
        // payment-service on order.failed. The buyer gets NO payment details.
        await this.deps.runInTransaction(async (tx) => {
          const locked = await this.deps.ordersRepository.lock(tx, order.id);
          if (locked?.status === 'PENDING_ADMIN_CONFIRMATION' && locked.stockStatus === 'PENDING')
            await this.deps.orderLifecycle.failInTx(tx, locked, 'STOCK_UNAVAILABLE', SYSTEM, ctx, {
              stockTo: 'FAILED',
              note: err.reason ?? err.message,
            });
        });
        const e = err.toAppError();
        throw new ConflictError(e.message, {
          details: { ...(err.details as object), orderId: order.id, orderNo: order.orderNo },
        });
      }
      throw err; // 503: outcome unknown — retry with the same key (or the stuck-orders job)
    }
    if (stock.value !== null) await this.recordReserved(order, stock.value, ctx);

    if (payment.status === 'rejected') {
      const err: unknown = payment.reason;
      if (err instanceof UpstreamRefusal && err.reason === 'ALREADY_PAID')
        return { order: await this.detail(await this.mustFind(order.id)), payment: null };
      throw err instanceof UpstreamRefusal ? err.toAppError() : err;
    }
    const intent = payment.value;
    if (intent !== null && order.activePaymentId !== intent.paymentId)
      await this.deps.runInTransaction(async (tx) => {
        const locked = await this.deps.ordersRepository.lock(tx, order.id);
        if (locked !== null && locked.activePaymentId === null)
          await this.deps.ordersRepository.update(tx, order.id, {
            activePaymentId: intent.paymentId,
          });
      });
    return { order: await this.detail(await this.mustFind(order.id)), payment: intent };
  }

  /** "Pay now" on an unpaid order (same payment, same gateway order). */
  async pay(user: AuthUser, orderId: string, ctx: Ctx): Promise<CheckoutResult> {
    const order = await this.owned(user, orderId);
    if (
      order.status !== 'PENDING_ADMIN_CONFIRMATION' ||
      !UNPAID_STATUSES.includes(order.paymentStatus)
    )
      throw refusal(
        `This order cannot be paid (${order.status}, payment ${order.paymentStatus})`,
        'NOT_PAYABLE',
      );
    if (order.paymentDueAt.getTime() <= Date.now())
      throw refusal('The payment window for this order has ended', 'PAYMENT_WINDOW_CLOSED');
    const r = await this.advance(order, ctx);
    if (r.payment === null) throw refusal('This order cannot be paid right now', 'NOT_PAYABLE');
    return { ...r, replayed: false };
  }

  // ── Buyer cancellation ──

  async cancellationQuote(user: AuthUser, orderId: string, lines: CancelInput['lines']) {
    const order = await this.owned(user, orderId);
    return this.deps.orderCancelService.quote(order, { lines }, { type: 'CUSTOMER', id: user.id });
  }

  /** Idempotent by key: a retried tap returns the same result, never a second cancellation. */
  async cancel(
    user: AuthUser,
    orderId: string,
    key: string,
    input: CancelInput,
    ctx: Ctx,
  ): Promise<OrderDetailView> {
    await this.owned(user, orderId);
    const hash = requestHash({ orderId, ...input });
    const earlier = await this.deps.ordersRepository.cancellationByKey(key);
    if (earlier !== null) {
      if (
        earlier.requestedBy !== user.id ||
        earlier.requestHash !== hash ||
        earlier.orderId !== orderId
      )
        throw new ValidationError(
          [{ path: 'headers.idempotency-key', message: 'already used for a different request' }],
          'Idempotency-Key reused with a different request',
        );
      return this.detail(await this.mustFind(orderId));
    }
    try {
      await this.deps.orderCancelService.cancel(
        orderId,
        input,
        { type: 'CUSTOMER', id: user.id },
        { ctx, key, hash },
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error; // a double tap with the same key won the race
    }
    return this.detail(await this.mustFind(orderId));
  }

  // ── Reads ──

  async list(user: AuthUser, query: OrderListQuery): Promise<Paginated<OrderSummaryView>> {
    const page = await this.deps.ordersRepository.listForUser(user.id, query);
    return { ...page, items: page.items.map(toSummary) };
  }

  /**
   * F1 HOOK: issue the tax invoice for a dispatched shipment, INSIDE the dispatch transaction.
   * Locks the order row (concurrent shipments of one order serialise), reads its checkout
   * snapshot and delegates to the invoices feature. Idempotent per shipment.
   */
  async issueShipmentInvoiceInTx(
    tx: Tx,
    orderId: string,
    shipment: ShipmentRequest,
    issuedBy: string | null,
  ): Promise<IssuedDocument> {
    const { ordersRepository, transactionsService, invoicesService } = this.deps;
    if ((await ordersRepository.lock(tx, orderId)) === null) throw new NotFoundError('Order');
    const order = await ordersRepository.find(orderId, tx);
    if (order === null) throw new NotFoundError('Order');
    const method = await transactionsService.paymentMethod(tx, orderId);
    return invoicesService.issueForShipment(tx, toInvoiceFacts(order, method), shipment, issuedBy);
  }

  /** The buyer's money ledger for one own order (another buyer's id → 404). */
  async transactions(user: AuthUser, orderId: string): Promise<OrderLedgerView> {
    await this.owned(user, orderId);
    return this.deps.transactionsService.forOrder(orderId);
  }

  async get(user: AuthUser, orderId: string): Promise<OrderDetailView> {
    return this.detail(await this.owned(user, orderId));
  }

  /** Internal callers (support, inventory) also get the owner ids for their own access checks. */
  async getInternal(
    orderId: string,
  ): Promise<OrderDetailView & { userId: string; farmId: string }> {
    const order = await this.mustFind(orderId);
    return { ...(await this.detail(order)), userId: order.userId, farmId: order.farmId };
  }

  statuses(ids: readonly string[]) {
    return this.deps.ordersRepository.statuses(ids);
  }

  // ── Jobs ──

  /** Unpaid past window + grace: live gateway check first (R6), then FAILED (D-43). */
  async failUnpaidDue(): Promise<{ failed: number }> {
    const { paymentGraceSeconds } = await this.deps.settingsService.current();
    const due = await this.deps.ordersRepository.unpaidDue(
      new Date(Date.now() - paymentGraceSeconds * 1000),
      JOB_BATCH,
    );
    let failed = 0;
    for (const o of due) {
      if (o.activePaymentId !== null) {
        const live = await this.deps.paymentClient
          .liveStatus(o.activePaymentId)
          .catch((err: unknown) => {
            this.deps.logger.warn(
              { err, orderId: o.id },
              'payment live check failed; retry next run',
            );
            return null;
          });
        if (live === null || ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(live.status))
          continue; // unknown, or paid: the payment.captured event will arrive
      }
      const done = await this.deps.runInTransaction(async (tx) => {
        const locked = await this.deps.ordersRepository.lock(tx, o.id);
        if (
          locked?.status !== 'PENDING_ADMIN_CONFIRMATION' ||
          !UNPAID_STATUSES.includes(locked.paymentStatus)
        )
          return false;
        await this.deps.orderLifecycle.failInTx(tx, locked, 'PAYMENT_NOT_COMPLETED', SYSTEM, {
          correlationId: `payment-timeout:${o.id}`,
        });
        return true;
      });
      if (done) failed += 1;
    }
    return { failed };
  }

  /** Placements interrupted mid-way (R2): resume; give up after 10 minutes. */
  async resumeStuck(): Promise<{ resumed: number; failed: number }> {
    const stuck = await this.deps.ordersRepository.stuck(
      new Date(Date.now() - STUCK_AFTER_MS),
      JOB_BATCH,
    );
    let resumed = 0;
    let failed = 0;
    for (const order of stuck) {
      const ctx = { correlationId: `stuck-orders:${order.id}` };
      try {
        await this.advance(order, ctx);
        resumed += 1;
      } catch (err) {
        if (err instanceof ConflictError) continue; // refused → the order was failed by advance
        if (
          Date.now() - order.placedAt.getTime() < GIVE_UP_AFTER_MS ||
          order.stockStatus !== 'PENDING'
        ) {
          this.deps.logger.warn({ err, orderId: order.id }, 'resume failed; next run retries');
          continue;
        }
        await this.deps.runInTransaction(async (tx) => {
          const locked = await this.deps.ordersRepository.lock(tx, order.id);
          if (locked?.status === 'PENDING_ADMIN_CONFIRMATION' && locked.stockStatus === 'PENDING')
            await this.deps.orderLifecycle.failInTx(tx, locked, 'PLACEMENT_ERROR', SYSTEM, ctx);
        });
        failed += 1;
      }
    }
    return { resumed, failed };
  }

  // ── Helpers ──

  private async reserve(
    order: OrderWithLines,
    windowMinutes: number,
    graceSeconds: number,
  ): Promise<Reservation> {
    const address = order.deliveryAddress as { pinCode: string };
    const ttl = Math.min(3_600, windowMinutes * 60 + graceSeconds);
    try {
      return await this.deps.inventoryClient.reserve({
        orderId: order.id,
        pinCode: address.pinCode,
        lines: order.lines.map((l) => ({ variantId: l.variantId, qty: l.qty })),
        ttlSeconds: ttl,
      });
    } catch (err) {
      // A live reservation for this order already exists (earlier attempt succeeded): adopt it.
      if (err instanceof UpstreamRefusal && err.reason === 'ORDER_ALREADY_RESERVED') {
        const live = (await this.deps.inventoryClient.byOrder(order.id)).find((r) =>
          ['ACTIVE', 'COMMITTED'].includes(r.status),
        );
        if (live !== undefined) return live;
      }
      throw err;
    }
  }

  /** PENDING → RESERVED exactly once; ordered units leave the cart in the same transaction. */
  private async recordReserved(order: OrderWithLines, r: Reservation, ctx: Ctx): Promise<void> {
    await this.deps.runInTransaction(async (tx) => {
      const locked = await this.deps.ordersRepository.lock(tx, order.id);
      // Closed meanwhile (e.g. timed out): the close event already asked inventory to release.
      if (locked?.stockStatus !== 'PENDING' || locked.status !== 'PENDING_ADMIN_CONFIRMATION')
        return;
      await this.deps.orderLifecycle.apply(
        tx,
        locked,
        { stockStatus: r.status === 'COMMITTED' ? 'COMMITTED' : 'RESERVED' },
        { type: 'SERVICE', id: null },
        { code: r.split === true ? 'SPLIT_ALLOCATION' : null },
        { reservationId: r.id },
      );
      const cart = await this.deps.cartService.checkoutSnapshot(order.userId);
      if (cart !== null)
        await this.deps.cartService.removeOrderedInTx(
          tx,
          cart.cartId,
          order.lines.map((l) => ({ variantId: l.variantId, qty: l.qty })),
        );
    });
    this.deps.logger.debug(
      { orderId: order.id, correlationId: ctx.correlationId },
      'stock reserved',
    );
  }

  private createPayment(order: OrderRow): Promise<PaymentCheckout> {
    return this.deps.paymentClient.createForOrder({
      orderId: order.id,
      orderNo: order.orderNo,
      userId: order.userId,
      amountPaise: toPaise(order.grandTotal.toFixed(2)),
      expiresAt: order.paymentDueAt,
      method: order.paymentMethod,
    });
  }

  /**
   * Wallet checkout pre-check (before any order or stock hold): frozen or short → 409, nothing
   * created. The debit in payment-service is still the authority (a race just fails the payment).
   */
  private async checkWallet(userId: string, payablePaise: number): Promise<void> {
    const w = await this.deps.walletClient.balance(userId);
    if (w.status === 'FROZEN')
      throw refusal('Your wallet is frozen; choose another way to pay', 'WALLET_FROZEN');
    if (w.balancePaise < payablePaise)
      throw refusal(
        'Your wallet balance is too low for this order',
        'INSUFFICIENT_WALLET_BALANCE',
        {
          balancePaise: w.balancePaise,
          requiredPaise: payablePaise,
          shortPaise: payablePaise - w.balancePaise,
        },
      );
  }

  private async address(userId: string, addressId: string): Promise<AddressSnapshot> {
    try {
      const a = await this.deps.addressClient.snapshot(userId, addressId);
      if (a.deleted)
        throw new ValidationError([{ path: 'body.addressId', message: 'has been deleted' }]);
      return a;
    } catch (err) {
      if (err instanceof UpstreamRefusal && err.status === 404)
        throw new ValidationError([{ path: 'body.addressId', message: 'unknown address' }]);
      if (err instanceof ServiceUnavailableError || err instanceof ValidationError) throw err;
      throw err;
    }
  }

  private checkSellable(
    lines: readonly { variantId: string; qty: number }[],
    variants: readonly {
      variantId: string;
      isPrescriptionRequired: boolean;
      minOrderQty: number;
      maxOrderQty: number | null;
    }[],
    billToGst: boolean,
    gstin: string | null,
  ): void {
    const byId = new Map(variants.map((v) => [v.variantId, v]));
    const issues = lines.flatMap((l, i) => {
      const v = byId.get(l.variantId);
      const path = `cart.lines[${String(i)}]`;
      if (v === undefined) return [{ path, message: 'is not available' }];
      if (v.isPrescriptionRequired)
        return [{ path, message: 'needs a valid prescription (RX_REQUIRED); not orderable yet' }];
      if (l.qty < v.minOrderQty)
        return [{ path, message: `minimum ${String(v.minOrderQty)} per order` }];
      if (v.maxOrderQty !== null && l.qty > v.maxOrderQty)
        return [{ path, message: `maximum ${String(v.maxOrderQty)} per order` }];
      return [];
    });
    if (billToGst && gstin === null)
      issues.push({ path: 'body.billToGst', message: 'the farm has no verified GSTIN' });
    if (issues.length > 0) throw new ValidationError(issues, 'Some items cannot be ordered');
  }

  private async owned(user: AuthUser, orderId: string): Promise<OrderWithLines> {
    const order = await this.deps.ordersRepository.find(orderId);
    // Another buyer's order answers exactly like a missing one (no existence leak).
    if (order?.userId !== user.id) throw new NotFoundError('Order');
    return order;
  }

  private async mustFind(orderId: string): Promise<OrderWithLines> {
    const order = await this.deps.ordersRepository.find(orderId);
    if (order === null) throw new NotFoundError('Order');
    return order;
  }

  private async detail(order: OrderWithLines): Promise<OrderDetailView> {
    const [events, refunds] = await Promise.all([
      this.deps.ordersRepository.events(order.id),
      this.deps.ordersRepository.refundRequests(order.id),
    ]);
    return toDetail(order, events, refunds);
  }
}
