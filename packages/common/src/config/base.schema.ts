import Joi from 'joi';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export const APP_ENVS = ['local', 'dev', 'prod'] as const;
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];
export type AppEnv = (typeof APP_ENVS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Env vars every service must have. Service schemas are merged on top of this. */
export interface BaseConfig {
  NODE_ENV: NodeEnv;
  /** Deployment target: local laptop, dev-prod, or main-prod. */
  APP_ENV: AppEnv;
  SERVICE_NAME: string;
  /** Set by CI to the image tag / git sha. */
  SERVICE_VERSION: string;
  HOST: string;
  PORT: number;
  LOG_LEVEL: LogLevel;
  SHUTDOWN_TIMEOUT_MS: number;
}

export const baseEnvSchema = Joi.object<BaseConfig>({
  NODE_ENV: Joi.string()
    .valid(...NODE_ENVS)
    .default('development'),
  APP_ENV: Joi.string()
    .valid(...APP_ENVS)
    .default('local'),
  SERVICE_NAME: Joi.string()
    .pattern(/^[a-z][a-z0-9-]*$/)
    .required(),
  SERVICE_VERSION: Joi.string().default('0.0.0'),
  HOST: Joi.string().default('0.0.0.0'),
  PORT: Joi.number().port().required(),
  LOG_LEVEL: Joi.string()
    .valid(...LOG_LEVELS)
    .default('info'),
  SHUTDOWN_TIMEOUT_MS: Joi.number().integer().min(1000).max(120_000).default(25_000),
});
