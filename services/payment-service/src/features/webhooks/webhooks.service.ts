import { createHash, randomUUID } from 'node:crypto';

import { BadRequestError, UnauthorizedError } from '@farmx/common/errors';
import type { Cradle } from '@fastify/awilix';

import type { GatewayPayment } from '../../adapters/gateway.js';
import { MockGateway } from '../../adapters/mock-gateway.js';
import {
  type RzpPayment,
  type RzpRefund,
  toPayment,
  toRefund,
} from '../../adapters/razorpay.js';

type Deps = Pick<
  Cradle,
  'webhooksRepository' | 'gateway' | 'paymentsService' | 'refundsService' | 'logger'
>;

interface RzpWebhook {
  event?: string;
  payload?: {
    payment?: { entity?: RzpPayment };
    refund?: { entity?: RzpRefund };
  };
}

const PAYMENT_EVENTS = new Set([
  'payment.captured',
  'payment.failed',
  'payment.authorized',
  'order.paid',
]);
const REFUND_EVENTS = new Set(['refund.processed', 'refund.failed', 'refund.created']);
const BATCH = 50;

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/**
 * Gateway webhooks. The HTTP handler only verifies the signature over the RAW body, stores the
 * delivery once (provider event id) and answers 200 — processing happens in the `webhook-process`
 * job (every 2 s), through the same idempotent paths as verify / reconcile.
 */
export class WebhooksService {
  constructor(private readonly deps: Deps) {}

  async receive(
    raw: Buffer,
    signature: string | undefined,
    eventIdHeader: string | undefined,
  ): Promise<{ stored: boolean }> {
    if (signature === undefined || !this.deps.gateway.verifyWebhookSignature(raw, signature)) {
      this.deps.logger.warn({ bytes: raw.length }, 'webhook with a missing or invalid signature');
      throw new UnauthorizedError('Invalid webhook signature');
    }
    let body: RzpWebhook;
    try {
      body = JSON.parse(raw.toString('utf8')) as RzpWebhook;
    } catch {
      throw new BadRequestError('Webhook body is not JSON');
    }
    const type = typeof body.event === 'string' ? body.event.slice(0, 60) : 'unknown';
    const eventId = (eventIdHeader ?? `sha256:${sha256(raw)}`).slice(0, 80);
    const stored = await this.deps.webhooksRepository.insert({
      provider: this.deps.gateway.name,
      eventId,
      type,
      payloadSha256: sha256(raw),
      payload: body,
    });
    return { stored };
  }

  /** Deliveries that mention a gateway order (admin payment detail). */
  forPaymentOrder(providerOrderId: string) {
    return this.deps.webhooksRepository.forPaymentOrder(providerOrderId);
  }

  /** Mock gateway only: what Razorpay would POST to us, correctly signed. */
  async receiveMock(event: string, data: { payment: GatewayPayment }): Promise<void> {
    const gateway = this.deps.gateway;
    if (!(gateway instanceof MockGateway)) return;
    const p = data.payment;
    const entity: RzpPayment = {
      id: p.id,
      order_id: p.orderId,
      amount: p.amountPaise,
      currency: p.currency,
      status: p.status,
      method: p.method,
      vpa: p.vpa,
      card: p.cardLast4 === null ? null : { last4: p.cardLast4, network: p.cardNetwork ?? undefined },
      bank: p.bank,
      wallet: p.wallet,
      error_code: p.errorCode,
      error_description: p.errorReason,
    };
    const raw = Buffer.from(
      JSON.stringify({ entity: 'event', event, payload: { payment: { entity } }, created_at: Math.floor(Date.now() / 1000) }),
    );
    await this.receive(raw, gateway.signWebhook(raw), `evt_mock_${randomUUID()}`);
  }

  /** Job: apply stored deliveries (idempotent; a failure is retried up to 10 times). */
  async processPending(): Promise<{ processed: number }> {
    const rows = await this.deps.webhooksRepository.pending(BATCH);
    let processed = 0;
    for (const row of rows) {
      try {
        const note = await this.handle(row.type, row.payload as RzpWebhook);
        await this.deps.webhooksRepository.done(row.id, note);
        processed += 1;
      } catch (err) {
        this.deps.logger.warn({ err, webhookId: row.id, type: row.type }, 'webhook processing failed');
        await this.deps.webhooksRepository.failed(row.id, err instanceof Error ? err.message : String(err));
      }
    }
    return { processed };
  }

  /** Returns a note for ignored / unknown deliveries (stored with the row), null when applied. */
  private async handle(type: string, body: RzpWebhook): Promise<string | null> {
    if (PAYMENT_EVENTS.has(type)) {
      const entity = body.payload?.payment?.entity;
      if (entity === undefined) return 'no payment entity';
      const gp = toPayment(entity);
      if (gp.orderId === null) return 'payment without a gateway order';
      const payment = await this.deps.paymentsService.byProviderOrder(gp.orderId);
      if (payment === null) return 'UNKNOWN_GATEWAY_ORDER';
      await this.deps.paymentsService.applyGatewayPayment(payment.id, gp, 'webhook');
      return null;
    }
    if (REFUND_EVENTS.has(type)) {
      const entity = body.payload?.refund?.entity;
      if (entity === undefined) return 'no refund entity';
      if (type === 'refund.created') return 'ignored (send result already recorded)';
      return (await this.deps.refundsService.onGatewayRefund(toRefund(entity))) ? null : 'UNKNOWN_REFUND';
    }
    return `ignored event ${type}`;
  }
}
