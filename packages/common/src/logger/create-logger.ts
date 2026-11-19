import { type DestinationStream, type LevelWithSilent, type Logger, pino } from 'pino';

import { DEFAULT_REDACT_PATHS, REDACT_CENSOR } from './redact.js';

export interface CreateLoggerOptions {
  service: string;
  level?: LevelWithSilent;
  /** `local` | `dev` | `prod`. Pretty output defaults to on only for `local`. */
  appEnv?: string;
  version?: string;
  /** Force pretty (human-readable) output on or off. */
  pretty?: boolean;
  /** Extra redact paths, added to the defaults. */
  redact?: readonly string[];
  /** Custom output stream (tests). Ignored when pretty output is on. */
  destination?: DestinationStream;
}

/**
 * JSON logger for every service:
 * `{"level":"info","time":"<ISO>","service":"auth-service","env":"local","version":"0.0.0","msg":"..."}`
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const appEnv = options.appEnv ?? 'local';
  const pretty = options.pretty ?? appEnv === 'local';

  const loggerOptions = {
    level: options.level ?? 'info',
    base: { service: options.service, env: appEnv, version: options.version ?? '0.0.0' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
    redact: { paths: [...DEFAULT_REDACT_PATHS, ...(options.redact ?? [])], censor: REDACT_CENSOR },
  };

  if (pretty) {
    return pino({
      ...loggerOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,env,version',
          messageFormat: '[{service}] {msg}',
        },
      },
    });
  }

  return options.destination ? pino(loggerOptions, options.destination) : pino(loggerOptions);
}

export type { Logger, LevelWithSilent } from 'pino';
