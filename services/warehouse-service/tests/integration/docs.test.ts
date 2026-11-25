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
      // D-62 gate & weighbridge (panel + admin audiences, setup)
      '/wms/gate/summary',
      '/wms/gate/shipments',
      '/wms/gate/shipments/{id}',
      '/wms/gate/entries',
      '/wms/gate/entries/{id}/approve',
      '/wms/gate/entries/{id}/turn-away',
      '/wms/gate/entries/{id}/weighments',
      '/wms/gate/entries/{id}/reconciliation',
      '/wms/gate/entries/{id}/exit',
      '/wms/gate/passes/scan',
      '/wms/gate/passes/{passNo}/reissue',
      '/wms/gate/weighments/{id}/review',
      '/wms/gate/appointments/slots',
      '/wms/gate/asns/{id}/convert',
      '/wms/gate/visitors',
      '/wms/gate/security-checks',
      '/admin/wms/gate/summary',
      '/admin/warehouses/{id}/weigh-scales',
      '/admin/warehouses/{id}/gate-settings',
    ])
      expect(paths).toContain(p);
    // Every gate route is documented with a summary and a tag (D-62).
    const spec = res.json<{
      paths: Record<string, Record<string, { summary?: string; tags?: string[] }>>;
    }>();
    const gate = Object.entries(spec.paths).filter(
      ([p]) => p.includes('/gate/') || p.includes('weigh-scales') || p.includes('gate-settings'),
    );
    expect(gate.length).toBeGreaterThan(80);
    for (const [p, ops] of gate)
      for (const [m, op] of Object.entries(ops)) {
        expect(op.summary, `${m} ${p}`).toBeTruthy();
        expect(op.tags?.length, `${m} ${p}`).toBe(1);
      }
    expect(Object.keys(spec.paths).some((p) => p.startsWith('/internal/'))).toBe(false);
  });
});
