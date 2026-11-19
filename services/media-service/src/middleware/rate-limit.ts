import { RateLimitError, UnauthorizedError } from '@farmx/common/errors';
import { hitRateLimit, mediaKeys } from '@farmx/infra/redis';
import type { preHandlerAsyncHookHandler } from 'fastify';

export const UPLOAD_LIMIT = 30;
export const UPLOAD_WINDOW_SECONDS = 600;

/** preHandler (after requireAuth): 30 uploads per 10 minutes per user, then 429 + Retry-After. */
export const rateLimitUploads: preHandlerAsyncHookHandler = async (request, reply) => {
  if (request.user === null) throw new UnauthorizedError();
  const redis = request.diScope.resolve('redis');
  const result = await hitRateLimit(
    redis,
    mediaKeys.uploadRateLimit(request.user.id),
    UPLOAD_LIMIT,
    UPLOAD_WINDOW_SECONDS,
  );
  if (!result.allowed) {
    void reply.header('retry-after', String(result.retryAfterSeconds));
    throw new RateLimitError(result.retryAfterSeconds);
  }
};
