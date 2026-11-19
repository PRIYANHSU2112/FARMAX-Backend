import type Joi from 'joi';

import { type BaseConfig, baseEnvSchema } from './base.schema.js';

export type Env = Record<string, string | undefined>;

export interface CreateConfigOptions {
  /** Source of env vars. Defaults to `process.env`. */
  env?: Env;
}

/** Thrown at boot when env vars are missing or invalid. Lists every problem at once. */
export class ConfigValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

/**
 * Validates env vars against the base schema merged with the service's own schema.
 *
 * - Fails fast with ALL errors (not just the first).
 * - Applies defaults and type conversion ("3000" → 3000).
 * - Drops env vars that no schema declares, so config holds only what is validated.
 * - Returns a deeply frozen object.
 *
 * Env files are loaded by Node itself (`node --env-file-if-exists=.env`), not here.
 */
export function createConfig<T extends object = object>(
  schema?: Joi.ObjectSchema<T>,
  options: CreateConfigOptions = {},
): Readonly<BaseConfig & T> {
  const fullSchema = (
    schema ? baseEnvSchema.concat(schema as unknown as Joi.ObjectSchema<BaseConfig>) : baseEnvSchema
  ) as Joi.ObjectSchema<BaseConfig & T>;

  const result = fullSchema.validate(options.env ?? process.env, {
    abortEarly: false,
    allowUnknown: true,
    stripUnknown: true,
    convert: true,
  });

  if (result.error) {
    throw new ConfigValidationError(result.error.details.map((detail) => detail.message));
  }

  return deepFreeze(result.value);
}
