// `@farmx/database` — helpers any layer may use (no client, no tables).
// The Prisma client and model types live in `@farmx/database/client` (repositories, container
// and scripts only).
export * from './helpers/create-prisma.js';
export * from './helpers/health.js';
export * from './helpers/pagination.js';
export * from './helpers/outbox.js';
export {
  isUniqueViolation,
  mapPrismaError,
  prismaErrorCode,
  uniqueViolationFields,
  withPrismaErrors,
} from './helpers/prisma-errors.js';
export {
  type RunInTransaction,
  type Tx,
  advisoryXactLock,
  createTransactionRunner,
} from './transaction.js';
