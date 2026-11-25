import { type Redis, warehouseKeys } from '@farmx/infra/redis';

/**
 * D-62 gate cache version: INCR'd AFTER every committed write that changes what the gate screens
 * show (gate writes, CN receipts linked to a gate entry, INBOUND dock bookings). It is part of
 * every gate ETag and cache key, so a cached body is never older than the last write. A failed
 * INCR (Redis down) only means the minute bucket refreshes the cache (≤ 60 s stale).
 */
export const bumpGateVersion = async (redis: Redis, warehouseId: string): Promise<void> => {
  try {
    await redis.incr(warehouseKeys.gateVersion(warehouseId));
  } catch {
    /* best effort: the minute bucket bounds staleness */
  }
};

/** Current version string, or null when Redis is unavailable (the caller bypasses the cache). */
export const readGateVersion = async (
  redis: Redis,
  warehouseId: string,
): Promise<string | null> => {
  try {
    return (await redis.get(warehouseKeys.gateVersion(warehouseId))) ?? '0';
  } catch {
    return null;
  }
};
