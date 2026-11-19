import type { Cradle } from '@fastify/awilix';
import type { AwilixContainer } from 'awilix';
import type { FastifyPluginAsync } from 'fastify';

import type { HealthCheck } from './health.js';

/**
 * One business module of a service (modular monolith).
 * Lives in `src/features/<name>/<name>.module.ts` and is exported from the feature's `index.ts`.
 */
export interface ServiceModule {
  /** Unique within the service, kebab-case, e.g. `sessions`. */
  name: string;
  /** Registers the module's providers (service, repository, controller, ...) in the container. */
  register?: (container: AwilixContainer<Cradle>) => void;
  /** The module's HTTP routes. */
  routes?: FastifyPluginAsync;
  /** Route prefix, added after the service `routePrefix`. Default: none. */
  prefix?: string;
  /** Readiness checks this module contributes (named `<module>.<check>`). */
  healthChecks?: Readonly<Record<string, HealthCheck>>;
}

const MODULE_NAME = /^[a-z][a-z0-9-]*$/;

/** Identity helper that type-checks a module definition. */
export const defineModule = (module: ServiceModule): ServiceModule => module;

/** Throws on invalid or duplicate module names (fail fast at boot). */
export const assertModules = (modules: readonly ServiceModule[]): void => {
  const seen = new Set<string>();
  for (const { name } of modules) {
    if (!MODULE_NAME.test(name)) throw new Error(`Invalid module name "${name}" (use kebab-case)`);
    if (seen.has(name)) throw new Error(`Duplicate module "${name}"`);
    seen.add(name);
  }
};

/** Merges service-level and module-level readiness checks. */
export const collectHealthChecks = (
  serviceChecks: Readonly<Record<string, HealthCheck>>,
  modules: readonly ServiceModule[],
): Record<string, HealthCheck> => {
  const checks: Record<string, HealthCheck> = { ...serviceChecks };
  for (const module of modules) {
    for (const [name, check] of Object.entries(module.healthChecks ?? {})) {
      checks[`${module.name}.${name}`] = check;
    }
  }
  return checks;
};
