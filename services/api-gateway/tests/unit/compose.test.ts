import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Production runs backend/docker-compose.yml, not infra/docker/compose.stack.yml. A service left
// out of it is never deployed and shows "fetch failed" in the gateway Swagger. This test fails
// as soon as a new services/<name> folder is missing from the prod compose or the gateway docs.
const backend = fileURLToPath(new URL('../../../../', import.meta.url));
const compose = readFileSync(`${backend}docker-compose.yml`, 'utf8');
const docsModule = readFileSync(
  `${backend}services/api-gateway/src/features/docs/docs.module.ts`,
  'utf8',
);
const services = readdirSync(`${backend}services`, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== '_template')
  .map((d) => d.name);
const upstreams = services.filter((s) => s !== 'api-gateway');
const urlKey = (svc: string) => `${svc.replace(/-service$/, '').toUpperCase()}_SERVICE_URL`;

describe('production docker-compose.yml', () => {
  it.each(services)('builds and runs %s', (svc) => {
    expect(compose).toMatch(new RegExp(`^  ${svc}:$`, 'm'));
    expect(compose).toMatch(new RegExp(`SERVICE_NAME: ${svc} \\}`));
  });

  it.each(upstreams)('gives every container the %s URL and the gateway waits for it', (svc) => {
    expect(compose).toMatch(new RegExp(`^  ${urlKey(svc)}: http://${svc}:\\d+$`, 'm'));
    expect(compose).toMatch(new RegExp(`^      - ${svc}$`, 'm'));
  });

  it.each(upstreams)('merges the %s spec into the gateway Swagger', (svc) => {
    expect(docsModule).toContain(`config.${urlKey(svc)}`);
  });
});
