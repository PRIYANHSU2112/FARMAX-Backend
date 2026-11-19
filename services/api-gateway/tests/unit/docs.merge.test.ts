import { describe, expect, it } from 'vitest';

import { type FetchedSpec, mergeSpecs } from '../../src/features/docs/docs.merge.js';

const source = (service: string, publicPrefix: string) => ({
  service,
  baseUrl: `http://${service}`,
  publicPrefix,
  summary: service,
});

const op = (tag: string) => ({ tags: [tag], summary: tag });

const fetched: FetchedSpec[] = [
  {
    source: source('auth-service', '/v1/auth'),
    spec: {
      tags: [{ name: 'Health' }, { name: 'Admin Users', description: 'users' }],
      paths: {
        '/health/live': { get: op('Health') },
        '/admin/users': { get: op('Admin Users'), post: op('Admin Users') },
        '/internal/access/{id}': { get: op('Internal') },
      },
      components: {
        schemas: { ErrorBody: { type: 'object' }, User: { type: 'object' } },
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      },
    },
  },
  {
    source: source('catalog-service', '/v1'),
    spec: {
      tags: [
        { name: 'Health' },
        { name: 'Catalog · Categories', description: 'tree' },
        { name: 'Coming later' },
      ],
      paths: { '/catalog/categories': { get: op('Catalog · Categories') } },
      components: { schemas: { ErrorBody: { type: 'object' }, CategoryNode: { type: 'object' } } },
    },
  },
  { source: source('farm-service', '/v1'), spec: null, error: 'HTTP 503' },
];

describe('mergeSpecs', () => {
  const { doc, collisions } = mergeSpecs(fetched, { title: 'FarmX API', version: '1.0.0' });

  it('rewrites every path to its public gateway path and drops health/internal', () => {
    expect(Object.keys(doc.paths ?? {})).toEqual([
      '/v1/auth/admin/users',
      '/v1/catalog/categories',
    ]);
    expect(Object.keys(doc.paths?.['/v1/auth/admin/users'] ?? {})).toEqual(['get', 'post']);
  });

  it('keeps service section order, skips Health and empty sections, labels the owner', () => {
    expect(doc.tags?.map((t) => t.name)).toEqual(['Admin Users', 'Catalog · Categories']);
    expect(doc.tags?.[1]?.description).toBe('`catalog-service` · tree');
  });

  it('merges components once (identical shared components are not collisions)', () => {
    expect(Object.keys(doc.components?.schemas ?? {})).toEqual([
      'ErrorBody',
      'User',
      'CategoryNode',
    ]);
    expect(doc.components?.securitySchemes).toBeDefined();
    expect(collisions).toEqual([]);
  });

  it('uses the gateway itself as the server and reports unavailable services', () => {
    expect(doc.servers).toEqual([{ url: '/', description: 'This API gateway (same origin)' }]);
    const description = String(doc.info?.description);
    expect(description).toContain('`farm-service` | `/v1`');
    expect(description).toContain('unavailable (HTTP 503)');
    expect(description).toContain('[Admin Users](#/Admin%20Users)');
  });

  it('reports a duplicate operation and keeps the first', () => {
    const dup = mergeSpecs(
      [
        { source: source('a', '/v1'), spec: { paths: { '/x': { get: op('A') } } } },
        { source: source('b', '/v1'), spec: { paths: { '/x': { get: op('B') } } } },
      ],
      { title: 't', version: '1' },
    );
    expect(dup.collisions).toEqual(['GET /v1/x']);
    expect((dup.doc.paths?.['/v1/x']?.get as { summary: string }).summary).toBe('A');
  });
});
