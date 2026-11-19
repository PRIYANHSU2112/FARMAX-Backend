import type { Database } from './client.js';
import type { Prisma } from './generated/prisma/client.js';

/**
 * Interactive-transaction client. A service gets it from `runInTransaction` and passes it to other
 * features' services, whose repositories run their queries on it — so one action (e.g. suspend
 * user + revoke sessions + audit row) commits or rolls back as a unit.
 */
export type Tx = Prisma.TransactionClient;

export type RunInTransaction = <T>(work: (tx: Tx) => Promise<T>) => Promise<T>;

export const createTransactionRunner =
  (db: Database): RunInTransaction =>
  (work) =>
    db.$transaction(work, { maxWait: 5_000, timeout: 15_000 });

/** Transaction-scoped Postgres advisory lock: serialises one kind of change across replicas. */
export const advisoryXactLock = async (tx: Tx, key: string): Promise<void> => {
  // $executeRaw: the function returns `void`, which $queryRaw cannot deserialize (Prisma 7).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
};
