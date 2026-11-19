import type { CursorQuery, Paginated } from '@farmx/common/types';

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/** Prisma `findMany` arguments for keyset (cursor) pagination on a unique `id`. */
export interface CursorArgs {
  take: number;
  skip?: 1;
  cursor?: { id: string };
}

const clampLimit = (limit: number): number =>
  Math.min(Math.max(Math.trunc(limit) || DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);

/**
 * Builds `take/skip/cursor` for `findMany`. Fetches one extra row to know if more exist.
 * Combine with a stable `orderBy` on `id` (UUID v7 ids are time-ordered).
 *
 * ```ts
 * const rows = await prisma.session.findMany({
 *   where: { userId }, orderBy: { id: 'desc' }, ...cursorArgs(query),
 * });
 * return toPage(rows, query.limit);
 * ```
 */
export const cursorArgs = ({ cursor, limit }: CursorQuery): CursorArgs => {
  const take = clampLimit(limit) + 1;
  return cursor === undefined ? { take } : { take, skip: 1, cursor: { id: cursor } };
};

/** Turns the `limit + 1` rows from `cursorArgs` into a page. */
export const toPage = <T extends { id: string }>(
  rows: readonly T[],
  limit: number,
): Paginated<T> => {
  const size = clampLimit(limit);
  const hasMore = rows.length > size;
  const items = hasMore ? rows.slice(0, size) : [...rows];
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last ? last.id : null, limit: size };
};
