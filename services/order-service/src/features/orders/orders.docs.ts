import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { IDS, ok } from '../../docs/shared.js';

export const ORDERS_TAG = 'Orders';

const AUTH_BUYER =
  'Bearer access token of a `CUSTOMER` with full scope. Only the buyer sees or acts on an order; any other id answers 404 (existence is never revealed).';

const STATUS_TEXT =
  '`status` (business): PENDING_ADMIN_CONFIRMATION → CONFIRMED | REJECTED | CANCELLED | FAILED (system: unpaid, no stock, late payment). `paymentStatus`: PENDING · FAILED (retry allowed) · PAID · EXPIRED · PARTIALLY_REFUNDED · REFUNDED. `stockStatus`: PENDING · RESERVED · COMMITTED · RELEASE_REQUESTED · RELEASED · FAILED · REJECTED. `refundStatus`: NONE · REQUESTED · IN_PROGRESS · COMPLETED · PARTIALLY_COMPLETED · ACTION_REQUIRED.';

const checkoutPayment = Joi.object({
  paymentId: Joi.string().guid(),
  paymentNo: Joi.string().example('TXN-261121-9F3A21C4'),
  status: Joi.string().example('PENDING'),
  provider: Joi.string().valid('RAZORPAY', 'MOCK'),
  keyId: Joi.string()
    .example('rzp_live_XXXX')
    .description('Public key for the gateway checkout SDK'),
  providerOrderId: Joi.string().example('order_N8xYz12AbCd'),
  amountPaise: Joi.number().integer().example(2782100),
  amount: Joi.string().example('27821.00'),
  currency: Joi.string().example('INR'),
  expiresAt: Joi.date().iso(),
}).meta({ className: 'PaymentCheckout' });

const summary = {
  id: IDS.order,
  orderNo: 'ORD-26-0091842',
  status: 'PENDING_ADMIN_CONFIRMATION',
  failureCode: null,
  paymentMethod: 'ONLINE',
  paymentStatus: 'PENDING',
  stockStatus: 'RESERVED',
  refundStatus: 'NONE',
  placedAt: '2026-11-23T09:00:00.000Z',
  paymentDueAt: '2026-11-23T09:30:00.000Z',
  itemCount: 2,
  firstItemName: 'ND LaSota Live Vaccine 1,000 doses',
  grandTotal: '27821.00',
  currency: 'INR',
};

export const ORDER_DOCS = {
  checkout: {
    tag: ORDERS_TAG,
    summary: 'Place an order from the cart',
    description: `Prices, offers, GST and stock are re-checked on the server (client amounts are never trusted). The order is created as **PENDING_ADMIN_CONFIRMATION** with stock held for the payment window, and the response carries the gateway checkout details. Pay with the gateway SDK, then call \`POST /v1/payments/{paymentId}/verify\`.

**Wallet (D-54):** \`paymentMethod: "WALLET"\` pays the whole order from the FarmX wallet (never split with the gateway). The balance is checked first — **409 INSUFFICIENT_WALLET_BALANCE** (details \`balancePaise\`, \`requiredPaise\`, \`shortPaise\`) or **409 WALLET_FROZEN**, and nothing is created. After the stock hold the wallet is debited at once: \`payment.status\` is CAPTURED (no gateway step), or FAILED with \`INSUFFICIENT_WALLET_BALANCE\` if the balance changed meanwhile (top up, then \`POST /v1/orders/{id}/pay\`). Refunds of a wallet-paid order go back to the wallet.

**Idempotent:** a retry with the same \`Idempotency-Key\` continues the same order (never a second one). A **503** means the outcome is not known yet — retry with the same key. **409 INSUFFICIENT_STOCK / NOT_SERVICEABLE**: the order is FAILED (details carry \`orderId\` and the shortfall) and nothing can be paid.

${STATUS_TEXT}`,
    auth: AUTH_BUYER,
    rateLimit: '10 per user per minute',
    headers: {
      'Idempotency-Key': {
        required: true,
        description: '8–64 chars `[A-Za-z0-9._:-]`; one per "Place order" tap',
        schema: { type: 'string', example: 'chk-7f3a9c21-01' },
      },
    },
    requestExample: {
      farmId: IDS.farm,
      addressId: IDS.address,
      cartVersion: 7,
      billToGst: true,
      paymentMethod: 'ONLINE',
    },
    success: {
      status: 201,
      description: 'Order placed (201) or continued (200, same key)',
      example: ok({
        order: summary,
        payment: {
          paymentId: IDS.payment,
          paymentNo: 'TXN-261123-9F3A21C4',
          status: 'PENDING',
          provider: 'RAZORPAY',
          keyId: 'rzp_live_XXXX',
          providerOrderId: 'order_N8xYz12AbCd',
          amountPaise: 2782100,
          amount: '27821.00',
          currency: 'INR',
          expiresAt: '2026-11-23T09:30:00.000Z',
        },
      }),
    },
    errors: [400, 404, 409, 422, 503],
    errorExamples: {
      409: [
        {
          summary: 'Cart changed',
          message: 'Your cart changed after the price was checked.',
          details: { reason: 'CART_CHANGED' },
        },
        {
          summary: 'Out of stock',
          message: 'Not enough stock for this order at the serving warehouses',
          details: {
            reason: 'INSUFFICIENT_STOCK',
            orderId: IDS.order,
            shortfall: [{ variantId: IDS.variant, requested: 12, available: 5 }],
          },
        },
        {
          summary: 'Offer ran out',
          message: 'An offer in your cart has just run out.',
          details: { reason: 'PROMO_LIMIT_REACHED' },
        },
      ],
    },
  },
  list: {
    tag: ORDERS_TAG,
    summary: 'My orders',
    description:
      'Tabs: `active` (awaiting confirmation / confirmed), `completed`, `cancelled` (rejected, cancelled, failed). `paymentDueAt` is set only while the order can still be paid ("Stock hold" countdown).',
    auth: AUTH_BUYER,
    success: {
      status: 200,
      description: 'A page of orders',
      paginated: true,
      example: { success: true, data: [summary], meta: { nextCursor: null, limit: 20 } },
    },
    errors: [422],
  },
  get: {
    tag: ORDERS_TAG,
    summary: 'Order detail',
    description: `Lines, totals, billing, delivery address, the full **timeline** (every status change), refunds (requested vs completed) and the \`actions\` the buyer may take now.\n\n${STATUS_TEXT}`,
    auth: AUTH_BUYER,
    success: { status: 200, description: 'Order' },
    errors: [404, 422],
  },
  pay: {
    tag: ORDERS_TAG,
    summary: 'Pay now (retry a failed or abandoned payment)',
    description:
      'Allowed while the order awaits confirmation, is unpaid (PENDING / FAILED) and the payment window is open. Returns the SAME payment and gateway order (never a second charge).',
    auth: AUTH_BUYER,
    rateLimit: '20 per user per minute',
    success: {
      status: 200,
      description: 'Order + gateway checkout',
      data: Joi.object({ order: Joi.object(), payment: checkoutPayment }),
    },
    errors: [404, 409, 422, 503],
    errorExamples: {
      409: {
        message: 'The payment window for this order has ended',
        details: { reason: 'PAYMENT_WINDOW_CLOSED' },
      },
    },
  },
  quote: {
    tag: ORDERS_TAG,
    summary: 'Cancellation preview',
    description:
      'What cancelling the whole order (no `lines`) or some items would refund now, the fee (only after the free window, as a % of the refund) and when the free window ends. Nothing changes. An unpaid order can only be cancelled as a whole.',
    auth: AUTH_BUYER,
    rateLimit: '30 per user per minute',
    requestExample: { lines: [{ variantId: IDS.variant, qty: 1 }] },
    success: {
      status: 200,
      description: 'Quote',
      example: ok({
        eligible: true,
        reason: null,
        full: false,
        freeWindowEndsAt: '2026-11-23T10:00:00.000Z',
        fee: '0.00',
        refundAmount: '7896.00',
        lines: [{ lineNo: 1, variantId: IDS.variant, qty: 1, refund: '7896.00' }],
      }),
    },
    errors: [404, 422],
  },
  cancel: {
    tag: ORDERS_TAG,
    summary: 'Cancel my order (whole or some items)',
    description:
      'Allowed while awaiting confirmation or confirmed (until picking starts, later phase). The refund of what was paid for the cancelled items (minus a fee only after the free window) is started automatically; stock is released. `reasonCode`: ORDERED_BY_MISTAKE · FLOCK_DELAYED · LOWER_PRICE · VET_ADVISED · OTHER. Idempotent by `Idempotency-Key`.',
    auth: AUTH_BUYER,
    rateLimit: '10 per user per minute',
    headers: {
      'Idempotency-Key': {
        required: true,
        description: '8–64 chars; one per "Cancel" tap',
        schema: { type: 'string' },
      },
    },
    requestExample: {
      lines: [{ variantId: IDS.variant, qty: 1 }],
      reasonCode: 'FLOCK_DELAYED',
      note: 'Shed 2 placement moved',
    },
    success: { status: 200, description: 'Order after cancellation' },
    errors: [400, 404, 409, 422],
  },
} satisfies Record<string, RouteDocs>;
