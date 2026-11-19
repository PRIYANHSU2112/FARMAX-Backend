import { createHash, timingSafeEqual } from 'node:crypto';

import { UnauthorizedError } from '../errors/index.js';
import type { preHandlerAsyncHookHandler } from 'fastify';

export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * preHandler for `/internal/*` routes: requires the shared service-to-service token.
 * Compares SHA-256 digests in constant time (equal length, no timing leak).
 */
export const internalAuth = (expectedToken: string): preHandlerAsyncHookHandler => {
  if (expectedToken.length < 32) {
    throw new Error('internalAuth: token must be at least 32 characters');
  }
  const expected = digest(expectedToken);

  return async (request) => {
    const header = request.headers[INTERNAL_TOKEN_HEADER];
    const provided = Array.isArray(header) ? header[0] : header;
    if (provided === undefined || !timingSafeEqual(digest(provided), expected)) {
      throw new UnauthorizedError('Invalid internal token');
    }
  };
};
