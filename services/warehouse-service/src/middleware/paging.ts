import { AppError, ErrorCode } from '@farmx/common/errors';
import Joi from 'joi';

/**
 * D-57 list paging (§5): keyset `cursor` for every list; `page` (offset) only for numbered pagers
 * and only up to 2,000 rows deep (deeper → 422 USE_CURSOR). `total` is exact up to 10,000.
 */
export const MAX_OFFSET = 2_000;
export const TOTAL_CAP = 10_000;

export const PAGING = {
  cursor: Joi.string().max(400),
  page: Joi.number().integer().min(1).max(MAX_OFFSET),
  limit: Joi.number().integer().min(1).max(100).default(20),
};

export interface Paging {
  cursor?: string;
  page?: number;
  limit: number;
}

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
  limit: number;
  page?: number;
  total?: number;
  totalIsEstimate?: boolean;
}

/** Opaque keyset cursor = base64url(JSON array of the sort values of the last row). */
export const encodeCursor = (values: readonly unknown[]): string =>
  Buffer.from(JSON.stringify(values)).toString('base64url');

export const decodeCursor = (cursor: string | undefined): unknown[] | null => {
  if (cursor === undefined) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v)) return v as unknown[];
  } catch {
    /* fall through */
  }
  throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid cursor', 422, {
    details: {
      issues: [{ path: 'querystring.cursor', message: 'is not a cursor from this list' }],
    },
  });
};

/** Offset of a numbered page, or null for cursor paging. */
export const offsetOf = (p: Paging): number | null => {
  if (p.page === undefined) return null;
  const offset = (p.page - 1) * p.limit;
  if (offset > MAX_OFFSET)
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Page too deep; use the cursor', 422, {
      details: { reason: 'USE_CURSOR', maxOffset: MAX_OFFSET },
    });
  return offset;
};

/** Builds the page from `limit + 1` fetched rows. */
export const toPageResult = <T>(
  rows: T[],
  p: Paging,
  cursorOf: (row: T) => readonly unknown[],
  total?: number,
): PageResult<T> => {
  const items = rows.slice(0, p.limit);
  const more = rows.length > p.limit;
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      more && last !== undefined && p.page === undefined ? encodeCursor(cursorOf(last)) : null,
    limit: p.limit,
    ...(p.page === undefined ? {} : { page: p.page }),
    ...(total === undefined
      ? {}
      : { total: Math.min(total, TOTAL_CAP), totalIsEstimate: total > TOTAL_CAP }),
  };
};

/** `{ success, data, meta }` for a page (meta carries total / page when known). */
export const pageBody = <T>(page: PageResult<T>) => ({
  success: true as const,
  data: page.items,
  meta: {
    nextCursor: page.nextCursor,
    limit: page.limit,
    ...(page.page === undefined ? {} : { page: page.page }),
    ...(page.total === undefined
      ? {}
      : { total: page.total, totalIsEstimate: page.totalIsEstimate }),
  },
});

/** Swagger `meta` extras of a paged list. */
export const PAGE_META = Joi.object({
  page: Joi.number().integer(),
  total: Joi.number().integer(),
  totalIsEstimate: Joi.boolean(),
});

/** CSV cell: quote, double quotes, neutralise formula injection (= + - @ tab CR). */
export const csvCell = (v: string | number | boolean | Date | null | undefined): string => {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : v.toString();
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
