import path from 'node:path';

/**
 * Enforces the feature boundaries inside every service
 * (implementation-plan/05-modular-monolith.md):
 *
 * 1. A service never imports another service's code.
 * 2. A feature imports another feature ONLY through its public API: `features/<name>/index.ts`.
 * 3. `src/shared/` (if present) never imports from `src/features/`.
 * 4. Everything else in `src/` (app, container, server, routes/, middleware/) uses feature public APIs only.
 *
 * Only relative imports are checked; workspace packages (`@farmx/*`) are always allowed.
 */

const SERVICE_PATH = /\/services\/([^/]+)\/(.*)$/;

/** Classifies an absolute file path inside `services/`. */
const locate = (absolutePath) => {
  const match = SERVICE_PATH.exec(absolutePath.replaceAll('\\', '/'));
  if (!match) return undefined;
  const [, service, rest] = match;

  const moduleMatch = /^src\/features\/([^/]+)\/(.+)$/.exec(rest);
  if (moduleMatch) {
    return { service, area: 'module', module: moduleMatch[1], file: moduleMatch[2] };
  }
  if (rest.startsWith('src/shared/')) return { service, area: 'shared' };
  if (rest.startsWith('src/')) return { service, area: 'root' };
  return { service, area: 'other' }; // test/, prisma/, config files
};

const isPublicApi = (file) => /^index(\.[cm]?[jt]s)?$/.test(file);

/** @type {import('eslint').Rule.RuleModule} */
export const moduleBoundaries = {
  meta: {
    type: 'problem',
    docs: { description: 'Enforce feature boundaries inside services' },
    schema: [],
    messages: {
      crossService:
        'Services must not import each other\'s code ("{{target}}"). Use RabbitMQ events or internal HTTP.',
      deepImport:
        'Import feature "{{module}}" through its public API (features/{{module}}/index.ts), not "{{file}}".',
      sharedToModule: 'src/shared/ must not depend on features (imports feature "{{module}}").',
    },
  },

  create(context) {
    const importer = locate(context.filename);
    if (!importer) return {};

    const check = (node) => {
      const source = node.source;
      if (source?.type !== 'Literal' || typeof source.value !== 'string') return;
      const specifier = source.value;
      if (!specifier.startsWith('.')) return;

      const target = locate(path.resolve(path.dirname(context.filename), specifier));
      if (!target) return;

      if (target.service !== importer.service) {
        context.report({ node: source, messageId: 'crossService', data: { target: specifier } });
        return;
      }
      if (target.area !== 'module') return;

      if (importer.area === 'shared') {
        context.report({
          node: source,
          messageId: 'sharedToModule',
          data: { module: target.module },
        });
        return;
      }

      const sameModule = importer.area === 'module' && importer.module === target.module;
      const enforced = importer.area === 'module' || importer.area === 'root';
      if (enforced && !sameModule && !isPublicApi(target.file)) {
        context.report({
          node: source,
          messageId: 'deepImport',
          data: { module: target.module, file: target.file },
        });
      }
    };

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    };
  },
};
