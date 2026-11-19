import { describe, expect, it } from 'vitest';

import { ConfigValidationError, Joi, createConfig } from '../index.js';

const baseEnv = { SERVICE_NAME: 'auth-service', PORT: '3001' };

describe('createConfig', () => {
  it('applies defaults and converts types', () => {
    const config = createConfig(undefined, { env: baseEnv });
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      APP_ENV: 'local',
      SERVICE_NAME: 'auth-service',
      SERVICE_VERSION: '0.0.0',
      HOST: '0.0.0.0',
      PORT: 3001,
      LOG_LEVEL: 'info',
      SHUTDOWN_TIMEOUT_MS: 25_000,
    });
  });

  it('merges a service schema on top of the base schema', () => {
    interface AuthConfig {
      DATABASE_URL: string;
      JWT_ACCESS_TTL: string;
    }
    const schema = Joi.object<AuthConfig>({
      DATABASE_URL: Joi.string()
        .uri({ scheme: ['postgresql'] })
        .required(),
      JWT_ACCESS_TTL: Joi.string().default('15m'),
    });

    const config = createConfig(schema, {
      env: { ...baseEnv, DATABASE_URL: 'postgresql://u:p@localhost:5432/auth_db' },
    });

    expect(config.DATABASE_URL).toBe('postgresql://u:p@localhost:5432/auth_db');
    expect(config.JWT_ACCESS_TTL).toBe('15m');
    expect(config.PORT).toBe(3001);
  });

  it('reports every invalid variable at once', () => {
    const schema = Joi.object({ DATABASE_URL: Joi.string().required() });
    const run = () => createConfig(schema, { env: { PORT: 'abc', LOG_LEVEL: 'loud' } });

    expect(run).toThrow(ConfigValidationError);
    try {
      run();
    } catch (error) {
      const { issues } = error as ConfigValidationError;
      expect(issues).toHaveLength(4);
      expect(issues.join('\n')).toMatch(/SERVICE_NAME.*required/);
      expect(issues.join('\n')).toMatch(/PORT/);
      expect(issues.join('\n')).toMatch(/LOG_LEVEL/);
      expect(issues.join('\n')).toMatch(/DATABASE_URL.*required/);
    }
  });

  it('drops undeclared env vars and freezes the result', () => {
    const config = createConfig(undefined, {
      env: { ...baseEnv, PATH: '/usr/bin', SECRET_X: 'y' },
    });
    expect(config).not.toHaveProperty('PATH');
    expect(config).not.toHaveProperty('SECRET_X');
    expect(Object.isFrozen(config)).toBe(true);
  });
});
