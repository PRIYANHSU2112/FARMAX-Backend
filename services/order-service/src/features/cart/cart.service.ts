import { AppError, ConflictError, ErrorCode, NotFoundError } from '@farmx/common/errors';
import type { AuthUser } from '@farmx/common/types';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import { type SellableVariant, type VariantFacts, isSellable } from '../projections/index.js';
import type {
  AddItemInput,
  CartOwner,
  CartRow,
  CartWriteView,
  LineWriteResult,
  LockedCart,
  MergeResult,
  SetItemInput,
} from './cart.types.js';
import { HARD_MAX_QTY, buildCartLines } from './cart.views.js';

type Deps = Pick<
  Cradle,
  | 'cartRepository'
  | 'projectionsService'
  | 'promotionsService'
  | 'offersService'
  | 'runInTransaction'
  | 'config'
>;

const unprocessable = (reason: string, message: string, extra: Record<string, unknown> = {}) =>
  new AppError(ErrorCode.VALIDATION_ERROR, message, 422, { details: { reason, ...extra } });

/** Same normalisation as stored promotion codes (trim + UPPERCASE). */
const normalizeCode = (code: string) => code.trim().toUpperCase();

/** Highest quantity a line may hold: the variant's max, the hard cap and the known stock. */
const ceilingOf = (v: SellableVariant) =>
  Math.min(v.maxOrderQty ?? HARD_MAX_QTY, HARD_MAX_QTY, v.availableQty ?? HARD_MAX_QTY);

/**
 * Cart for guests (`X-Cart-Token`) and customers (JWT), merged on login.
 *
 * - Writes: one short transaction per request — lock the cart row, then one statement that checks
 *   limits on a fresh snapshot, writes the line and bumps `version` (see CartRepository).
 * - Reads: cart + lines in one query, variants in one query, offers/GST only when a farm is given.
 * - Prices are never trusted from the client; the snapshot is only for "price changed" notices.
 * - Stock is a SOFT check (inventory-service projection; unknown never blocks). The reservation
 *   happens when the order is placed.
 */
export class CartService {
  constructor(private readonly deps: Deps) {}

  private get maxLines() {
    return this.deps.config.CART_MAX_LINES;
  }

  private get ttl() {
    return this.deps.config.CART_GUEST_TTL_DAYS;
  }

  // ── Reads ──

  /** Revalidated cart (FR-SHP-05). With a `farmId` (customers): offers, freight and the GST bill. */
  async get(owner: CartOwner | null, user: AuthUser | null, farmId?: string) {
    const cart = owner === null ? null : await this.deps.cartRepository.find(owner);
    const variants = await this.deps.projectionsService.variants(
      cart?.lines.map((l) => l.variantId) ?? [],
    );
    const byId = new Map(variants.map((v) => [v.variantId, v]));
    const built = buildCartLines(cart, byId);
    return {
      cartId: cart?.id ?? null,
      cartVersion: cart?.version ?? 0,
      couponCode: cart?.couponCode ?? null,
      itemCount: built.lines.length,
      totalQty: built.totalQty,
      lines: built.lines,
      notices: built.notices,
      consignments: built.consignments,
      summary: { itemSubtotal: built.itemSubtotal, checkoutBlocked: built.checkoutBlocked },
      pricing: await this.price(cart, byId, variants, user, farmId),
    };
  }

  private async price(
    cart: CartRow | null,
    byId: ReadonlyMap<string, VariantFacts>,
    variants: readonly VariantFacts[],
    user: AuthUser | null,
    farmId: string | undefined,
  ) {
    if (user === null || farmId === undefined || cart === null) return null;
    const lines = cart.lines
      .filter((l) => isSellable(byId.get(l.variantId)))
      .map((l) => ({ variantId: l.variantId, qty: l.qty }));
    if (lines.length === 0) return null;
    return this.deps.offersService.forCart(
      user,
      { farmId, lines, ...(cart.couponCode === null ? {} : { couponCode: cart.couponCode }) },
      variants,
    );
  }

  /** The customer's cart as checkout reads it (lines, coupon, version); null = no cart. */
  async checkoutSnapshot(userId: string) {
    const cart = await this.deps.cartRepository.find({ userId });
    return cart === null
      ? null
      : {
          cartId: cart.id,
          version: cart.version,
          couponCode: cart.couponCode,
          lines: cart.lines.map((l) => ({ variantId: l.variantId, qty: l.qty })),
        };
  }

  // ── Writes ──

  /** "Add to cart" / "+": adds to the line's quantity (creates the cart, and a guest token, if needed). */
  async addItem(owner: CartOwner, input: AddItemInput): Promise<CartWriteView> {
    const v = await this.sellable(input.variantId);
    if (v.availableQty !== null && v.availableQty <= 0)
      throw unprocessable('OUT_OF_STOCK', 'This item is out of stock', { availableQty: 0 });
    const max = ceilingOf(v);
    return this.write(
      owner,
      true,
      async (tx, cart) => {
        const r = await this.deps.cartRepository.addQty(tx, cart.id, {
          variantId: v.variantId,
          qty: input.qty,
          min: v.minOrderQty,
          max,
          price: v.sellingPrice,
          maxLines: this.maxLines,
          guestTtlDays: this.ttl,
        });
        if (r.qty === null) throw this.refused(r, (r.current ?? 0) + input.qty, v);
        return r;
      },
      v.variantId,
    );
  }

  /** Stepper / quantity box: absolute quantity, 0 removes the line. Optional optimistic version. */
  async setItem(owner: CartOwner, variantId: string, input: SetItemInput): Promise<CartWriteView> {
    if (input.qty === 0) return this.removeItem(owner, variantId, input.expectedVersion);
    const v = await this.sellable(variantId);
    const max = ceilingOf(v);
    if (input.qty < v.minOrderQty || input.qty > max) throw this.limitError(input.qty, v);
    return this.write(
      owner,
      true,
      async (tx, cart) => {
        this.checkVersion(cart, input.expectedVersion);
        const r = await this.deps.cartRepository.setQty(tx, cart.id, {
          variantId,
          qty: input.qty,
          price: v.sellingPrice,
          maxLines: this.maxLines,
          guestTtlDays: this.ttl,
        });
        if (r.qty === null) throw this.cartFull();
        return r;
      },
      variantId,
    );
  }

  /** Removing a line that is not there is a no-op (idempotent; the version does not move). */
  async removeItem(
    owner: CartOwner,
    variantId: string,
    expectedVersion?: number,
  ): Promise<CartWriteView> {
    return this.write(
      owner,
      false,
      async (tx, cart) => {
        this.checkVersion(cart, expectedVersion);
        return this.deps.cartRepository.removeLine(tx, cart.id, variantId, this.ttl);
      },
      variantId,
    );
  }

  async clear(owner: CartOwner): Promise<CartWriteView> {
    return this.deps.runInTransaction(async (tx) => {
      const cart = await this.lockExisting(tx, owner);
      const version = await this.deps.cartRepository.clear(tx, cart.id, this.ttl);
      return { cartId: cart.id, cartVersion: version, itemCount: 0, line: null };
    });
  }

  /** Customers: store a coupon on the cart. It must exist and be live now; eligibility shows on GET. */
  async setCoupon(userId: string, code: string) {
    const normalized = normalizeCode(code);
    const live = await this.deps.promotionsService.activeForPricing(new Date());
    if (!live.some((p) => p.code === normalized))
      throw unprocessable('COUPON_NOT_FOUND', 'This coupon does not exist or has expired', {
        issues: [{ path: 'body.code', message: 'is not a live coupon' }],
      });
    return this.deps.runInTransaction(async (tx) => {
      const cart = await this.lockOrCreate(tx, { userId });
      const version = await this.deps.cartRepository.setCoupon(tx, cart.id, normalized);
      return { cartId: cart.id, cartVersion: version, couponCode: normalized };
    });
  }

  async removeCoupon(userId: string) {
    return this.deps.runInTransaction(async (tx) => {
      const cart = await this.lockExisting(tx, { userId });
      const version = await this.deps.cartRepository.setCoupon(tx, cart.id, null);
      return { cartId: cart.id, cartVersion: version, couponCode: null };
    });
  }

  /** "OK, got it" on price-change notices: every snapshot becomes the current price. */
  async refreshPrices(owner: CartOwner) {
    const cart = await this.deps.cartRepository.find(owner);
    if (cart === null) throw new NotFoundError('Cart');
    const variants = await this.deps.projectionsService.variants(
      cart.lines.map((l) => l.variantId),
    );
    const prices = new Map(variants.filter(isSellable).map((v) => [v.variantId, v.sellingPrice]));
    return this.deps.runInTransaction(async (tx) => {
      const locked = await this.lockExisting(tx, owner);
      const version =
        prices.size === 0
          ? locked.version
          : await this.deps.cartRepository.refreshSnapshots(tx, locked.id, prices);
      return { cartId: locked.id, cartVersion: version };
    });
  }

  /**
   * Guest → customer after login. Cheap indexed pre-check first, so the usual "already merged"
   * call costs one read and no transaction. Exactly-once is guaranteed in SQL (CartRepository.merge).
   */
  async mergeGuest(userId: string, guestToken: string): Promise<MergeResult | null> {
    if (!(await this.deps.cartRepository.guestCartExists(guestToken))) return null;
    return this.deps.runInTransaction(async (tx) => {
      const cart = await this.lockOrCreate(tx, { userId });
      return this.deps.cartRepository.merge(tx, {
        userCartId: cart.id,
        guestToken,
        maxLines: this.maxLines,
        hardMaxQty: HARD_MAX_QTY,
      });
    });
  }

  // ── Checkout hooks (orders feature, inside ITS transaction) ──

  /**
   * Locks the customer's cart (same lock order as every cart write) and checks it is still the
   * version the quote was priced from. Any +/−/add/remove/coupon/merge after the preview → 409.
   */
  async lockForCheckoutInTx(
    tx: Tx,
    userId: string,
    quotedVersion: number,
  ): Promise<{ cartId: string }> {
    const cart = await this.deps.cartRepository.lock(tx, { userId }, false, this.ttl);
    if (cart?.version !== quotedVersion)
      throw new ConflictError(
        'Your cart changed after the price was checked. Review it and try again.',
        {
          details: { reason: 'CART_CHANGED', quotedVersion, currentVersion: cart?.version ?? null },
        },
      );
    return { cartId: cart.id };
  }

  /** After the order rows: drop what was ordered (and the coupon), in the same transaction. */
  /** Checkout claimed the locked cart state: bump its version in the same transaction. */
  touchInTx(tx: Tx, cartId: string): Promise<void> {
    return this.deps.cartRepository.touch(tx, cartId);
  }

  removeOrderedInTx(
    tx: Tx,
    cartId: string,
    lines: readonly { variantId: string; qty: number }[],
  ): Promise<number> {
    return this.deps.cartRepository.removeOrdered(tx, cartId, lines);
  }

  // ── Helpers ──

  private async write(
    owner: CartOwner,
    create: boolean,
    work: (tx: Tx, cart: LockedCart) => Promise<LineWriteResult>,
    variantId: string,
  ): Promise<CartWriteView> {
    return this.deps.runInTransaction(async (tx) => {
      const cart = create ? await this.lockOrCreate(tx, owner) : await this.lockExisting(tx, owner);
      const r = await work(tx, cart);
      return {
        cartId: cart.id,
        cartVersion: r.version ?? cart.version,
        itemCount: r.lines,
        line: r.qty === null ? null : { variantId, qty: r.qty },
        ...(cart.created && cart.guestToken !== null ? { guestToken: cart.guestToken } : {}),
      };
    });
  }

  private async lockOrCreate(tx: Tx, owner: CartOwner): Promise<LockedCart> {
    const cart = await this.deps.cartRepository.lock(tx, owner, true, this.ttl);
    if (cart === null) throw new Error('cart not created');
    return cart;
  }

  private async lockExisting(tx: Tx, owner: CartOwner): Promise<LockedCart> {
    const cart = await this.deps.cartRepository.lock(tx, owner, false, this.ttl);
    if (cart === null) throw new NotFoundError('Cart');
    return cart;
  }

  private checkVersion(cart: LockedCart, expected: number | undefined) {
    if (expected !== undefined && cart.version !== expected)
      throw new ConflictError('The cart was changed on another device. Reload it and try again.', {
        details: {
          reason: 'CART_VERSION_CONFLICT',
          expectedVersion: expected,
          currentVersion: cart.version,
        },
      });
  }

  private async sellable(variantId: string): Promise<SellableVariant> {
    const [v] = await this.deps.projectionsService.variants([variantId]);
    if (!isSellable(v))
      throw unprocessable('VARIANT_NOT_SELLABLE', 'This item is not available for sale', {
        issues: [
          {
            path: 'variantId',
            message: 'is not available for sale (inactive, or price / HSN / GST rate missing)',
          },
        ],
      });
    return v;
  }

  /** Why the database refused an add (it changed nothing). */
  private refused(r: LineWriteResult, wanted: number, v: SellableVariant): AppError {
    if (r.current === null && r.lines >= this.maxLines) return this.cartFull();
    return this.limitError(wanted, v, r.current);
  }

  private limitError(wanted: number, v: SellableVariant, current: number | null = null): AppError {
    const extra = {
      requestedQty: wanted,
      currentQty: current,
      minOrderQty: v.minOrderQty,
      maxOrderQty: v.maxOrderQty,
    };
    if (v.availableQty !== null && wanted > v.availableQty)
      return unprocessable('OUT_OF_STOCK', `Only ${String(v.availableQty)} available`, {
        ...extra,
        availableQty: v.availableQty,
      });
    if (wanted < v.minOrderQty)
      return unprocessable('QTY_BELOW_MIN', `Minimum ${String(v.minOrderQty)} per order`, extra);
    return unprocessable(
      'QTY_LIMIT',
      `Maximum ${String(Math.min(v.maxOrderQty ?? HARD_MAX_QTY, HARD_MAX_QTY))} per order`,
      extra,
    );
  }

  private cartFull(): AppError {
    return unprocessable(
      'CART_FULL',
      `A cart can hold at most ${String(this.maxLines)} different items`,
      { maxLines: this.maxLines },
    );
  }
}
