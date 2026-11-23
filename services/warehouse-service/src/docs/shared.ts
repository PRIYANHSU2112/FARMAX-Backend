/** Swagger text shared by every warehouse-service feature (docs only; no runtime use). */
import type { RouteDocs } from '@farmx/common/server';
import type { Schema } from 'joi';

export const AUTH_STAFF =
  "Bearer access token of an `INTERNAL` (staff) user with full scope (MFA done) and the permission below, held GLOBALLY or at the warehouse in the path (D-56). A warehouse outside the caller's scope answers 404; a visible one without the permission answers 403.";

export const IF_VERSION =
  '`expectedVersion` from the last read is required; a stale version → 409 `VERSION_CONFLICT`.';

/** Example ids (UUID v7). */
export const IDS = {
  warehouse: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a01',
  depot: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a02',
  area: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7b01',
  manager: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e31',
} as const;

export const ok = (data: unknown, meta?: unknown) => ({
  success: true,
  data,
  ...(meta === undefined ? {} : { meta }),
});

/** Compact route docs for the setup screens (staff auth, permission, success, errors). */
export const staffDoc = (
  tag: string,
  summary: string,
  permission: string,
  o: {
    description?: string;
    status?: 200 | 201 | 204;
    data?: Schema;
    paginated?: boolean;
    errors?: readonly (400 | 404 | 409 | 422 | 503)[];
    requestExample?: unknown;
  } = {},
): RouteDocs => ({
  tag,
  summary,
  ...(o.description === undefined ? {} : { description: o.description }),
  auth: AUTH_STAFF,
  permission,
  ...(o.requestExample === undefined ? {} : { requestExample: o.requestExample }),
  success: {
    status: o.status ?? 200,
    description: o.status === 204 ? 'Done' : summary,
    ...(o.data === undefined ? {} : { data: o.data }),
    ...(o.paginated === true ? { paginated: true } : {}),
  },
  errors: o.errors ?? [404, 422],
});

export const AUTH_ADMIN =
  'Bearer access token of an `INTERNAL` (staff) user with full scope (MFA done) holding the permission below GLOBALLY (central admin panel, every warehouse).';

/** D-57 Swagger tag per audience: "WMS Panel · Stock" (warehouse panel) / "WMS Admin · Stock". */
export const wmsTag = (aud: 'panel' | 'admin', area: string): string =>
  `${aud === 'admin' ? 'WMS Admin' : 'WMS Panel'} · ${area}`;

/** D-57 route docs for one audience (same shape as `staffDoc`, audience-specific auth text). */
export const wmsDoc = (
  aud: 'panel' | 'admin',
  area: string,
  summary: string,
  permission: string,
  o: Parameters<typeof staffDoc>[3] = {},
): RouteDocs => ({
  ...staffDoc(wmsTag(aud, area), summary, permission, o),
  auth: aud === 'admin' ? AUTH_ADMIN : AUTH_STAFF,
});
