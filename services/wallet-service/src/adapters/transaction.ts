import { ServiceUnavailableError } from '@farmx/common/errors';
import { type RunInTransaction, prismaErrorCode } from '@farmx/database';

/** Postgres lock_not_available (lock_timeout hit). */
const LOCK_TIMEOUT = '55P03';
/** Prisma: could not start / finish the interactive transaction in time · pool timeout. */
const BUSY_PRISMA = new Set(['P2028', 'P2024']);

/** Walks the error chain (Prisma error → driver adapter error → pg error). */
const isBusy = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const e = current as {
      code?: unknown;
      originalCode?: unknown;
      cause?: unknown;
      meta?: { driverAdapterError?: unknown };
    };
    if (e.originalCode === LOCK_TIMEOUT || e.code === LOCK_TIMEOUT) return true;
    if (BUSY_PRISMA.has(prismaErrorCode(current) ?? '')) return true;
    current = e.meta?.driverAdapterError ?? e.cause;
  }
  return false;
};

/**
 * The wallet's transaction runner. Inside it every row-lock wait is capped (`lock_timeout`), so a
 * hot wallet answers fast instead of holding pool connections; a busy database or a lock wait
 * becomes 503 WALLET_BUSY. Retrying with the same idempotency key is always safe: nothing moved.
 */
export const createWalletTransactionRunner = (
  run: RunInTransaction,
  lockTimeoutMs = 3_000,
): RunInTransaction => {
  return async (work) => {
    try {
      return await run(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL lock_timeout = '${String(Math.trunc(lockTimeoutMs))}ms'`,
        );
        return work(tx);
      });
    } catch (error) {
      if (isBusy(error))
        throw new ServiceUnavailableError(
          'The wallet is busy; retry with the same Idempotency-Key',
          {
            cause: error,
            details: { reason: 'WALLET_BUSY' },
          },
        );
      throw error;
    }
  };
};
