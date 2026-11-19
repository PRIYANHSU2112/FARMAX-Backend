import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';

/** Stand-in for media-service: counts the raw bytes it receives at /upload. */
let upstream: FastifyInstance;
let received = { path: '', bytes: 0, contentType: '' };

beforeAll(async () => {
  upstream = Fastify();
  upstream.addContentTypeParser('*', (_req, payload, done) => {
    done(null, payload);
  });
  upstream.post('/upload', async (request) => {
    let bytes = 0;
    for await (const chunk of request.body as AsyncIterable<Buffer>) bytes += chunk.length;
    received = { path: request.url, bytes, contentType: String(request.headers['content-type']) };
    return { ok: true };
  });
  await upstream.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await upstream.close();
});

describe('gateway → media-service upload proxy', () => {
  it('streams an 8 MB multipart body to /upload (not cut by the 1 MB JSON body limit)', async () => {
    const address = upstream.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const gateway = await buildApp({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      MEDIA_SERVICE_URL: `http://127.0.0.1:${port}`,
    });
    try {
      const body = Buffer.alloc(8 * 1024 * 1024, 1);
      const res = await gateway.inject({
        method: 'POST',
        url: '/v1/upload?type=image',
        payload: body,
        headers: { 'content-type': 'multipart/form-data; boundary=xyz' },
      });
      expect(res.statusCode).toBe(200);
      expect(received).toEqual({
        path: '/upload?type=image',
        bytes: body.length,
        contentType: 'multipart/form-data; boundary=xyz',
      });
    } finally {
      await gateway.close();
    }
  });
});
