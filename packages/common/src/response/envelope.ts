import { type AppError, ErrorCode } from '../errors/index.js';
import type { Paginated } from '../types/index.js';

export interface PaginationMeta {
  nextCursor: string | null;
  limit: number;
}

export interface SuccessBody<T, M = never> {
  success: true;
  data: T;
  meta?: M;
}

export interface ErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export type ApiResponse<T, M = never> = SuccessBody<T, M> | ErrorBody;

/** `{ success: true, data }`. The HTTP status (200/201/…) is set by the controller. */
export const ok = <T>(data: T): SuccessBody<T> => ({ success: true, data });

/** `{ success: true, data: items, meta: { nextCursor, limit } }`. */
export const paginated = <T>(page: Paginated<T>): SuccessBody<T[], PaginationMeta> => ({
  success: true,
  data: page.items,
  meta: { nextCursor: page.nextCursor, limit: page.limit },
});

/**
 * `{ success: false, error: { code, message, details?, requestId? } }`.
 * Non-operational errors (bugs, infra failures) never expose their message or details.
 */
export const fail = (error: AppError, requestId?: string): ErrorBody => {
  const body: ErrorBody['error'] = error.isOperational
    ? error.toJSON()
    : { code: ErrorCode.INTERNAL_ERROR, message: 'Internal server error' };

  if (requestId !== undefined) body.requestId = requestId;
  return { success: false, error: body };
};
