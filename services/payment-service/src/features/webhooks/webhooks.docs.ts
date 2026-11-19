import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

export const WEBHOOKS_TAG = 'Payment Webhooks';

export const WEBHOOK_DOCS = {
  razorpay: {
    tag: WEBHOOKS_TAG,
    summary: 'Razorpay webhook',
    description:
      'Called by Razorpay only. `X-Razorpay-Signature` must be HMAC-SHA256 of the **raw body** with the webhook secret (constant-time check; invalid → 401). Each delivery is stored once by `X-Razorpay-Event-Id` (a redelivery answers `duplicate: true`) and processed in the background within seconds. Handled: `payment.captured`, `payment.failed`, `payment.authorized`, `order.paid`, `refund.processed`, `refund.failed`.',
    public: true,
    rateLimit: '600 per IP per minute',
    headers: {
      'X-Razorpay-Signature': { required: true, description: 'HMAC-SHA256 hex of the raw body' },
      'X-Razorpay-Event-Id': { description: 'Delivery id (deduplication key)' },
    },
    success: {
      status: 200,
      description: 'Stored (processed asynchronously)',
      data: Joi.object({ status: Joi.string().example('ok'), duplicate: Joi.boolean() }),
      example: { status: 'ok', duplicate: false },
    },
    errors: [400],
  },
} satisfies Record<string, RouteDocs>;
