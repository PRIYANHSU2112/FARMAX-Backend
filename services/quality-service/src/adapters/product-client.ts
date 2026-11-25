import type { Logger } from '@farmx/common/logger';
import { INTERNAL_TOKEN_HEADER } from '@farmx/common/middleware';
import type { VariantFactsV1 } from '@farmx/infra/events';
import type { QualityConfig } from '../config/index.js';

/** product-service `GET /internal/products/variants?ids=` (facts for a quality spec). */
export class ProductClient {
  constructor(private readonly deps: { config: QualityConfig; logger: Logger }) {}

  /** Facts of up to 100 variants; `null` = product-service unavailable. */
  async variantFacts(ids: readonly string[]): Promise<VariantFactsV1[] | null> {
    const { config, logger } = this.deps;
    if (ids.length === 0) return [];
    if (config.INTERNAL_SERVICE_TOKEN === undefined) return null;
    const out: VariantFactsV1[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const qs = ids
        .slice(i, i + 100)
        .map((id) => `ids=${encodeURIComponent(id)}`)
        .join('&');
      try {
        const res = await fetch(`${config.PRODUCT_SERVICE_URL}/internal/products/variants?${qs}`, {
          headers: { [INTERNAL_TOKEN_HEADER]: config.INTERNAL_SERVICE_TOKEN },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          logger.warn({ status: res.status }, 'product variant facts failed');
          return null;
        }
        const body = (await res.json()) as { data?: VariantFactsV1[] };
        out.push(...(body.data ?? []));
      } catch (err) {
        logger.warn({ err }, 'product-service unavailable for variant facts');
        return null;
      }
    }
    return out;
  }
}
