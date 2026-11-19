import { ConflictError, ServiceUnavailableError } from '@farmx/common/errors';
import type { Logger } from '@farmx/common/logger';
import { INTERNAL_TOKEN_HEADER } from '@farmx/common/middleware';

import type { CatalogConfig } from '../config/index.js';

export type ReferenceType = 'CATEGORY' | 'BRAND';

/**
 * product-service internal API for the safe-delete protocol (plan §E). product-service is the
 * authority over its references: `block` atomically checks "no live product uses it" and blocks
 * new assignments; catalog then soft-deletes, or calls `unblock` to compensate.
 * Without INTERNAL_SERVICE_TOKEN (local/tests) the protocol is skipped with a warning.
 */
export class ProductClient {
  constructor(private readonly deps: { config: CatalogConfig; logger: Logger }) {}

  private get token(): string | undefined {
    return this.deps.config.INTERNAL_SERVICE_TOKEN;
  }

  /** Throws 409 `<TYPE>_HAS_PRODUCTS` when products use it, 503 when product-service is down. */
  async block(refType: ReferenceType, refId: string): Promise<void> {
    if (this.token === undefined) {
      this.deps.logger.warn(
        { refType, refId },
        'INTERNAL_SERVICE_TOKEN unset: product usage not checked',
      );
      return;
    }
    let res: Response;
    try {
      res = await fetch(
        `${this.deps.config.PRODUCT_SERVICE_URL}/internal/products/reference-blocks`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', [INTERNAL_TOKEN_HEADER]: this.token },
          body: JSON.stringify({ refType, refId }),
          signal: AbortSignal.timeout(5_000),
        },
      );
    } catch (err) {
      this.deps.logger.error({ err }, 'product-service unreachable');
      throw new ServiceUnavailableError('Product service unavailable; nothing was deleted');
    }
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { details?: { count?: number } };
      };
      const count = body.error?.details?.count ?? 0;
      throw new ConflictError(
        `${refType === 'CATEGORY' ? 'Category' : 'Brand'} is used by ${String(count)} product(s); reassign or delete them first`,
        { details: { reason: `${refType}_HAS_PRODUCTS`, count } },
      );
    }
    if (!res.ok) throw new ServiceUnavailableError('Product service error; nothing was deleted');
  }

  /** Compensation after a failed delete (best effort; a stale block only refuses assignments). */
  async unblock(refType: ReferenceType, refId: string): Promise<void> {
    if (this.token === undefined) return;
    try {
      await fetch(
        `${this.deps.config.PRODUCT_SERVICE_URL}/internal/products/reference-blocks/${refType}/${refId}`,
        {
          method: 'DELETE',
          headers: { [INTERNAL_TOKEN_HEADER]: this.token },
          signal: AbortSignal.timeout(5_000),
        },
      );
    } catch (err) {
      this.deps.logger.error({ err, refType, refId }, 'reference unblock failed');
    }
  }
}
