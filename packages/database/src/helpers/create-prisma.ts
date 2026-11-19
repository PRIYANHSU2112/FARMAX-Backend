import type { Logger } from '@farmx/common/logger';

/** Prisma log levels routed to Pino via events (never Prisma's own stdout printing). */
export interface PrismaLogDefinition {
  emit: 'event';
  level: 'query' | 'warn' | 'error';
}

interface QueryEvent {
  query: string;
  duration: number;
  target: string;
}

interface LogEvent {
  message: string;
  target: string;
}

/** The subset of a generated PrismaClient this package relies on. */
interface PrismaEventSource {
  $on(event: 'query', callback: (event: QueryEvent) => void): unknown;
  $on(event: 'warn' | 'error', callback: (event: LogEvent) => void): unknown;
}

export interface CreatePrismaOptions {
  logger: Logger;
  /** Queries slower than this are logged as warnings. Default 200 ms. */
  slowQueryMs?: number;
  /** Log every query at debug level (local debugging only). Default false. */
  logAllQueries?: boolean;
}

const LOG_DEFINITIONS: PrismaLogDefinition[] = [
  { emit: 'event', level: 'query' },
  { emit: 'event', level: 'warn' },
  { emit: 'event', level: 'error' },
];

/**
 * Creates a service's Prisma client with logging wired to Pino.
 *
 * ```ts
 * const prisma = createPrisma(
 *   (log) => new PrismaClient({ adapter: new PrismaPg({ connectionString }), log }),
 *   { logger },
 * );
 * ```
 *
 * Query parameters are never logged (they can contain personal data).
 */
export function createPrisma<TClient>(
  factory: (log: PrismaLogDefinition[]) => TClient,
  options: CreatePrismaOptions,
): TClient {
  const client = factory(LOG_DEFINITIONS.map((definition) => ({ ...definition })));
  const events = client as unknown as PrismaEventSource;
  const logger = options.logger.child({ component: 'prisma' });
  const slowQueryMs = options.slowQueryMs ?? 200;

  events.$on('query', (event) => {
    if (event.duration >= slowQueryMs) {
      logger.warn({ durationMs: event.duration, query: event.query }, 'slow query');
    } else if (options.logAllQueries === true) {
      logger.debug({ durationMs: event.duration, query: event.query }, 'query');
    }
  });
  events.$on('warn', (event) => {
    logger.warn({ target: event.target }, event.message);
  });
  events.$on('error', (event) => {
    logger.error({ target: event.target }, event.message);
  });

  return client;
}
