declare const brand: unique symbol;

/** Nominal typing: `Brand<string, 'UserId'>` is not assignable from a plain string. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Brand<string, 'UserId'>;
export type SessionId = Brand<string, 'SessionId'>;

/** ISO-8601 timestamp string, e.g. `2026-11-04T10:00:00.000Z`. */
export type ISODateString = Brand<string, 'ISODateString'>;

export type Nullable<T> = T | null;

/** Cursor (keyset) pagination result. Offset pagination is not used. */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  limit: number;
}

export interface CursorQuery {
  cursor?: string;
  limit: number;
}
