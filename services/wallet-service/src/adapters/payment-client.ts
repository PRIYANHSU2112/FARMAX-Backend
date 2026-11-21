import { AppError, ErrorCode, ServiceUnavailableError } from '@farmx/common/errors';
import type { Logger } from '@farmx/common/logger';
import { INTERNAL_TOKEN_HEADER } from '@farmx/common/middleware';

import type { WalletConfig } from '../config/index.js';

/** A 4xx answer from payment-service: its business reason travels with it. */
export class PaymentRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown,
  ) {
    super(message);
    this.name = 'PaymentRefusal';
  }

  get reason(): string | undefined {
    return (this.details as { reason?: string } | undefined)?.reason;
  }

  toAppError(): AppError {
    const code = (Object.values(ErrorCode) as string[]).includes(this.code)
      ? (this.code as ErrorCode)
      : ErrorCode.CONFLICT;
    return new AppError(code, this.message, this.status, { details: this.details });
  }
}

/** What the app needs to open the gateway checkout (payment-service CheckoutView). */
export interface PaymentCheckout {
  paymentId: string;
  paymentNo: string;
  status: string;
  provider: string;
  keyId: string;
  providerOrderId: string | null;
  amountPaise: number;
  amount: string;
  currency: string;
  expiresAt: string;
}

/** payment-service PaymentView (the fields the wallet reads). */
export interface PaymentState {
  id: string;
  paymentNo: string;
  purpose: string;
  referenceId: string | null;
  status: string;
  amountPaise: number;
  capturedPaise: number;
  method: string | null;
  bank: string | null;
  cardLast4: string | null;
  cardNetwork: string | null;
  vpaMasked: string | null;
  failureCode: string | null;
  failureReason: string | null;
}

/**
 * payment-service `/internal/payments/*` (shared token, never through the gateway). Every call is
 * idempotent there (keyed by the top-up id), so a network failure is retried once; a still-unknown
 * outcome is 503 and is resolved by a retry or the reconcile job.
 */
export class PaymentClient {
  constructor(private readonly deps: { config: WalletConfig; logger: Logger }) {}

  createTopupPayment(input: {
    topupId: string;
    topupNo: string;
    userId: string;
    amountPaise: number;
    expiresAt: Date;
  }): Promise<PaymentCheckout> {
    return this.call('POST', '/internal/payments/topups', {
      ...input,
      currency: 'INR',
      expiresAt: input.expiresAt.toISOString(),
    });
  }

  /** Re-reads the gateway for an open payment, then returns it (lost-webhook guard). */
  liveStatus(paymentId: string): Promise<PaymentState> {
    return this.call('GET', `/internal/payments/${paymentId}/live-status`);
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
    const token = this.deps.config.INTERNAL_SERVICE_TOKEN;
    if (token === undefined)
      throw new ServiceUnavailableError(
        'payment-service is not configured (INTERNAL_SERVICE_TOKEN)',
      );
    for (let attempt = 1; ; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(`${this.deps.config.PAYMENT_SERVICE_URL}${path}`, {
          method,
          headers: {
            [INTERNAL_TOKEN_HEADER]: token,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(5_000),
        });
      } catch (err) {
        if (attempt < 2) continue;
        this.deps.logger.warn({ err, path }, 'payment-service call failed');
        throw new ServiceUnavailableError('Payments are unavailable; try again', { cause: err });
      }
      const json = (await res.json().catch(() => ({}))) as {
        data?: T;
        error?: { code?: string; message?: string; details?: unknown };
      };
      if (res.ok) return json.data as T;
      if (res.status >= 500 || res.status === 429) {
        if (attempt < 2 && res.status !== 429) continue;
        throw new ServiceUnavailableError('Payments are unavailable; try again');
      }
      throw new PaymentRefusal(
        res.status,
        json.error?.code ?? 'CONFLICT',
        json.error?.message ?? 'payment-service refused the request',
        json.error?.details,
      );
    }
  }
}
