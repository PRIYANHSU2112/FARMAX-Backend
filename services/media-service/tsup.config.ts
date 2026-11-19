import { readFileSync } from 'node:fs';

import { defineConfig } from 'tsup';

// Workspace packages (@farmx/*) are source-only TypeScript, so they are bundled into dist.
// Their third-party dependencies stay EXTERNAL (pino transports, fastify plugins, Prisma and
// native modules break when bundled) and must be listed in this service's package.json.
const workspaceDeps = ['common', 'infra'].flatMap((name) => {
  const manifest = JSON.parse(readFileSync(`../../packages/${name}/package.json`, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(manifest.dependencies ?? {}).filter((dep) => !dep.startsWith('@farmx/'));
});

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  noExternal: [/^@farmx\//],
  external: workspaceDeps,
});
