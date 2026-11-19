import type { DocHeader } from '@farmx/common/server';

/** Swagger text and headers shared by every catalog-service feature (docs only; no runtime use). */

export const AUTH_PUBLIC =
  'None (public storefront). Only active categories whose ancestors are all active are visible.';
export const AUTH_ADMIN =
  'Bearer access token of an `INTERNAL` (staff) user with full scope (MFA done) **and** the permission below. Customers and staff without it get 403.';

/** Request headers. */
export const IF_MATCH: Record<string, DocHeader> = {
  'If-Match': {
    description:
      'Category `version` from the last read (`3`, `"3"` or `W/"3"`). If it differs → 409 `CATEGORY_VERSION_CONFLICT`. Optional, recommended on every write.',
    schema: { type: 'string', example: '"3"' },
  },
};
export const IF_NONE_MATCH: Record<string, DocHeader> = {
  'If-None-Match': {
    description:
      'ETag from the previous response. If the category tree has not changed the server answers **304 Not Modified** with an empty body.',
    schema: { type: 'string', example: 'W/"q3Zc0m5mS3m1jv8aYk2Q1A"' },
  },
};
export const IDEMPOTENCY_KEY: Record<string, DocHeader> = {
  'Idempotency-Key': {
    description:
      'Optional, 8–64 chars `[A-Za-z0-9._-]`. A retry with the same key (same user, 24 h) replays the first response; a retry while the first call is still running → 409.',
    schema: { type: 'string', pattern: '^[A-Za-z0-9._-]{8,64}$', example: 'cat-create-7f3a9c21' },
  },
};

/** Response headers. */
export const TREE_ETAG: Record<string, DocHeader> = {
  ETag: {
    description: 'Weak ETag of the whole category tree. Send it back as `If-None-Match`.',
    schema: { type: 'string', example: 'W/"q3Zc0m5mS3m1jv8aYk2Q1A"' },
  },
  'Cache-Control': {
    description: '`public, max-age=60, stale-while-revalidate=300`',
    schema: { type: 'string' },
  },
};
export const VERSION_ETAG: Record<string, DocHeader> = {
  ETag: {
    description:
      'Current category `version`, quoted. Send it back as `If-Match` on the next write.',
    schema: { type: 'string', example: '"3"' },
  },
};

/** Example ids (UUID v7). */
export const IDS = {
  vaccines: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d6a01',
  live: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d6a02',
  nd: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d6a03',
  ibd: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d6a04',
  medicines: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d6a05',
  admin: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e31',
  audit: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e70',
} as const;

export const ok = (data: unknown, meta?: unknown) => ({
  success: true,
  data,
  ...(meta === undefined ? {} : { meta }),
});

export const reasonIssue = {
  summary: 'Missing or short reason',
  message: 'Validation failed',
  details: {
    issues: [
      { path: 'body.reason', message: '"reason" length must be at least 10 characters long' },
    ],
  },
};
