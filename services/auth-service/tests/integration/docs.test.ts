import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { docsEnabled } from '../../src/config/index.js';

const ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/farmx_test',
  DOCS_SERVER_LOCAL_URL: 'http://localhost:3000/v1/auth',
  DOCS_SERVER_PROD_URL: 'https://api.farmx.in/v1/auth',
} as NodeJS.ProcessEnv;

interface Operation {
  tags?: string[];
  security?: unknown[];
  parameters?: { name: string; in: string }[];
  requestBody?: unknown;
  responses: Record<string, { $ref?: string; content?: unknown }>;
}
interface Spec {
  openapi: string;
  servers: { url: string }[];
  tags: { name: string }[];
  info: { description: string };
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown>; responses: Record<string, unknown> };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const getSpec = async (env: NodeJS.ProcessEnv = ENV) => {
  app = await buildApp(env);
  const res = await app.inject({ method: 'GET', url: '/api-docs.json' });
  return { res, spec: res.json<Spec>() };
};

describe('Swagger / OpenAPI', () => {
  it('serves OpenAPI 3.0.3 with servers from env and every section', async () => {
    const { res, spec } = await getSpec();
    expect(res.statusCode).toBe(200);
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.servers.map((s) => s.url)).toEqual([
      'http://localhost:3000/v1/auth',
      'https://api.farmx.in/v1/auth',
    ]);
    expect(spec.tags.map((t) => t.name)).toEqual([
      'Health',
      'Auth',
      'User',
      'Admin Users',
      'Admin Roles',
      'Admin Audit Logs',
    ]);
    expect(spec.info.description).toContain('[Admin Users](#/Admin%20Users)');
    expect(spec.info.description).toContain('[Auth](#/Auth)');
    expect(spec.info.description).not.toContain('Coming soon');
  });

  it('keeps admin APIs in their own sections, locked, with $ref error responses', async () => {
    const { spec } = await getSpec();
    const list = spec.paths['/admin/users']?.get;
    expect(list?.tags).toEqual(['Admin Users']);
    expect(list?.security).toEqual([{ bearerAuth: [] }]);
    expect(list?.parameters?.map((p) => p.name)).toEqual(
      expect.arrayContaining(['cursor', 'limit', 'q', 'status', 'userType', 'includeDeleted']),
    );
    for (const status of ['401', '403', '422', '429', '500'])
      expect(list?.responses[status]?.$ref).toBeDefined();
    expect(list?.responses['200']?.content).toBeDefined();

    const create = spec.paths['/admin/users']?.post;
    expect(create?.requestBody).toBeDefined();
    expect(create?.responses['201']).toBeDefined();
    expect(create?.responses['409']?.$ref).toBe('#/components/responses/Conflict');

    expect(spec.paths['/admin/users/{id}']?.delete?.responses['204']).toBeDefined();
    expect(spec.paths['/admin/audit-logs']?.get?.tags).toEqual(['Admin Audit Logs']);
  });

  it('documents public health routes without a lock', async () => {
    const { spec } = await getSpec();
    expect(spec.paths['/health/live']?.get?.tags).toEqual(['Health']);
    expect(spec.paths['/health/live']?.get?.security).toBeUndefined();
  });

  it('publishes reusable schemas, enums and error responses', async () => {
    const { spec } = await getSpec();
    expect(Object.keys(spec.components.schemas)).toEqual(
      expect.arrayContaining([
        'User',
        'UserRole',
        'UserStatus',
        'UserType',
        'ScopeType',
        'AuditLog',
        'ErrorBody',
        'PaginationMeta',
      ]),
    );
    expect(Object.keys(spec.components.responses)).toEqual(
      expect.arrayContaining([
        'BadRequest',
        'Unauthorized',
        'Forbidden',
        'NotFound',
        'Conflict',
        'ValidationError',
        'RateLimited',
        'InternalError',
      ]),
    );
    expect(JSON.stringify(spec)).not.toContain('x-errors');
    expect(JSON.stringify(spec)).not.toContain('x-farmx-envelope');
  });

  it('is disabled with DOCS_ENABLED=false and off by default in prod', async () => {
    const off = await getSpec({ ...ENV, DOCS_ENABLED: 'false' });
    expect(off.res.statusCode).toBe(404);
    // A prod app cannot boot here (real secrets + SMS provider required), so check the rule itself.
    expect(docsEnabled({ APP_ENV: 'prod' })).toBe(false);
    expect(docsEnabled({ APP_ENV: 'prod', DOCS_ENABLED: true })).toBe(true);
    expect(docsEnabled({ APP_ENV: 'local' })).toBe(true);
  });
});
