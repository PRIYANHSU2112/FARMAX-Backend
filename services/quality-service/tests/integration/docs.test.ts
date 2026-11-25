import { describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';

describe('OpenAPI spec (merged by the gateway)', () => {
  it('publishes every quality route with its docs', async () => {
    const app = await buildApp({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/farmx_test',
    });
    const res = await app.inject({ method: 'GET', url: '/api-docs.json' });
    await app.close();
    expect(res.statusCode).toBe(200);
    const paths = Object.keys(res.json<{ paths: Record<string, unknown> }>().paths);
    for (const p of [
      '/quality/samples',
      '/quality/samples/summary',
      '/quality/samples/{id}',
      '/quality/samples/{id}/collect',
      '/quality/samples/{id}/send',
      '/quality/samples/{id}/lab-status',
      '/quality/samples/{id}/results',
      '/quality/coas',
      '/quality/coas/{id}',
      '/quality/coas/{id}/confirm-mapping',
      '/quality/coas/{id}/results',
      '/quality/coas/{id}/review',
      '/quality/batches/{batchId}/release-check',
      '/quality/batches/{batchId}/decisions',
      '/quality/decisions/{id}',
      '/quality/decisions/{id}/retry',
      '/quality/specs/{variantId}',
      '/quality/labs',
      '/quality/labs/{id}/test-connection',
      '/quality/audit',
      '/admin/quality/specs/{variantId}',
      '/certificates',
      '/certificates/units/{qrCode}',
      '/certificates/consignments/{cnNo}',
      '/certificates/consignments/{cnNo}/watch',
      '/verify/{code}',
    ])
      expect(paths).toContain(p);
    expect(paths.some((p) => p.includes('internal'))).toBe(false);
  });
});
