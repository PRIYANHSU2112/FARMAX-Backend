import { describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';

describe('OpenAPI spec (merged by the gateway)', () => {
  it('publishes every warehouse route with its docs', async () => {
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
      '/admin/warehouses',
      '/admin/warehouses/{id}',
      '/admin/warehouses/{id}/activate',
      '/admin/warehouses/{id}/service-areas',
      '/admin/warehouses/{id}/service-areas/{areaId}/reassign',
      '/admin/warehouses/coverage/{pinCode}',
      '/admin/warehouses/lookups',
      '/admin/wms/me',
      '/admin/wms/search',
    ])
      expect(paths).toContain(p);
  });
});
