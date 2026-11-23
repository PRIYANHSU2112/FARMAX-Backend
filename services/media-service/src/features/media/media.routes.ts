import multipart from '@fastify/multipart';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync } from 'fastify';

import { rateLimitUploads } from '../../middleware/rate-limit.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { MEDIA_DOCS } from './media.docs.js';
import type { PrivatePurpose } from './media.support.js';
import { type MediaKind, PARSER_MAX_BYTES } from './media.types.js';
import { uploadSchema } from './media.validation.js';

/**
 * `POST /upload` (public: `POST /v1/upload` via the gateway). Multipart is registered only in
 * this plugin, so no other route accepts file bodies.
 */
export const mediaRoutes: FastifyPluginAsync = async (app) => {
  await app.register(multipart, {
    limits: { fileSize: PARSER_MAX_BYTES, files: 1, fields: 5, parts: 6, headerPairs: 100 },
  });

  app.post<{ Querystring: { type?: MediaKind; purpose?: PrivatePurpose } }>(
    '/upload',
    {
      schema: { ...uploadSchema, ...routeDocs(MEDIA_DOCS.upload) },
      preHandler: [requireAuth, rateLimitUploads],
      bodyLimit: PARSER_MAX_BYTES + 1024 * 1024,
    },
    (request, reply) => request.diScope.resolve('mediaController').upload(request, reply),
  );
};
