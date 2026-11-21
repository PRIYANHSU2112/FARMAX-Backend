import { ServiceUnavailableError } from '@farmx/common/errors';
import type { Logger } from '@farmx/common/logger';
import { INTERNAL_TOKEN_HEADER } from '@farmx/common/middleware';

import type { PaymentConfig } from '../config/index.js';

/** wallet-service refused (4xx): INSUFFICIENT_BALANCE, ACCOUNT_FROZEN, EXCEEDS_DEBIT … */
export class WalletRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reason: string | null,
  ) {
    super(message);
    this.name = 'WalletRefusal';
  }
}

export interface WalletDebit {
  status: 'DEBITED' | 'NONE';
  paymentId: string;
  journalId: string | null;
  journalNo: string | null;
  amountPaise: number;
  refundedPaise: number;
}

export interface WalletCredit {
  refundId: string;
  journalId: string;
  journalNo: string;
  amountPaise: number;
}

/**
 * The WALLET payment provider (D-54): wallet-service `/internal/wallet/*` (shared token). Every
 * call is idempotent there (keys pay:<paymentId> / refund:<refundId>), so a network failure is
 * retried once; a still-unknown outcome is ServiceUnavailableError and is resolved by the
 * reconcile job (debit status) or the refund retry.
 */
export class WalletClient {
  constructor(private readonly deps: { config: PaymentConfig; logger: Logger }) {}

  debit(input: {
    paymentId: string;
    userId: string;
    orderId: string;
    orderNo: string;
    amountPaise: number;
  }): Promise<WalletDebit> {
    return this.call('POST', '/internal/wallet/debits', input);
  }

  debitStatus(paymentId: string): Promise<WalletDebit> {
    return this.call('GET', `/internal/wallet/debits/${paymentId}`);
  }

  credit(input: {
    refundId: string;
    paymentId: string;
    userId: string;
    amountPaise: number;
    reason: string;
  }): Promise<WalletCredit> {
    return this.call('POST', '/internal/wallet/credits', input);
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
    const token = this.deps.config.INTERNAL_SERVICE_TOKEN;
    if (token === undefined)
      throw new ServiceUnavailableError(
        'wallet-service is not configured (INTERNAL_SERVICE_TOKEN)',
      );
    for (let attempt = 1; ; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(`${this.deps.config.WALLET_SERVICE_URL}${path}`, {
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
        this.deps.logger.warn({ err, path }, 'wallet-service call failed');
        throw new ServiceUnavailableError('The wallet is unavailable; try again', { cause: err });
      }
      const json = (await res.json().catch(() => ({}))) as {
        data?: T;
        error?: { message?: string; details?: { reason?: string } };
      };
      if (res.ok) return json.data as T;
      if (res.status >= 500 || res.status === 429) {
        if (attempt < 2 && res.status !== 429) continue;
        throw new ServiceUnavailableError('The wallet is unavailable; try again');
      }
      throw new WalletRefusal(
        res.status,
        json.error?.message ?? 'wallet-service refused the request',
        json.error?.details?.reason ?? null,
      );
    }
  }
}
