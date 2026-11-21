import { ServiceUnavailableError } from '@farmx/common/errors';
import type { Logger } from '@farmx/common/logger';
import { INTERNAL_TOKEN_HEADER } from '@farmx/common/middleware';

import type { NotificationConfig } from '../config/index.js';

const TIMEOUT_MS = 3_000;

/** Which readers of a content item: its target segment, its savers, or both. */
export type ContentAudienceScope = 'segment' | 'savers' | 'both';

/**
 * farm-service's internal content audience (user ids only — no names, phones or locations).
 * Used only by the fan-out job. Any failure throws ServiceUnavailableError, which the job treats
 * as RETRYABLE (backoff, resume from the stored cursor), never as "no one".
 */
export class FarmDirectory {
  constructor(private readonly deps: { config: NotificationConfig; logger: Logger }) {}

  /** One keyset page of reader ids (ascending); `nextCursor` null = last page. */
  async contentAudience(
    contentId: string,
    scope: ContentAudienceScope,
    cursor: string | null,
    limit: number,
  ): Promise<{ ids: string[]; nextCursor: string | null }> {
    const { config, logger } = this.deps;
    if (config.INTERNAL_SERVICE_TOKEN === undefined)
      throw new ServiceUnavailableError('INTERNAL_SERVICE_TOKEN is not configured');
    const query = new URLSearchParams({ scope, limit: String(limit) });
    if (cursor !== null) query.set('cursor', cursor);
    const path = `/internal/farms/content/${encodeURIComponent(contentId)}/audience`;
    let res: Response;
    try {
      res = await fetch(`${config.FARM_SERVICE_URL}${path}?${query.toString()}`, {
        headers: { [INTERNAL_TOKEN_HEADER]: config.INTERNAL_SERVICE_TOKEN },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      logger.warn({ err: error, path }, 'farm directory unreachable');
      throw new ServiceUnavailableError('farm-service unavailable', { cause: error });
    }
    // The item was deleted meanwhile: nobody left to notify.
    if (res.status === 404) return { ids: [], nextCursor: null };
    if (!res.ok) throw new ServiceUnavailableError(`farm-service answered ${res.status}`);
    const body = (await res.json()) as { data?: { ids: string[]; nextCursor: string | null } };
    return body.data ?? { ids: [], nextCursor: null };
  }
}
