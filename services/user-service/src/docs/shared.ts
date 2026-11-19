import type { DocHeader } from '@farmx/common/server';

/** Swagger text and headers shared by every user-service feature (docs only; no runtime use). */

export const AUTH_CUSTOMER =
  'Bearer access token of a `CUSTOMER` user with full scope. Only the caller’s own records are visible; another user’s id answers 404.';
export const AUTH_ADMIN =
  'Bearer access token of an `INTERNAL` (staff) user with full scope (MFA done) **and** the permission below. Read-only.';
export const PERMISSION_VIEW = 'customers.view';
export const ADMIN_CUSTOMERS_TAG = 'Admin · Customer addresses & wishlist';
export const READ_RATE = '120 per user per minute';
export const WRITE_RATE = '30 per user per minute';

export const IDEMPOTENCY_KEY: Record<string, DocHeader> = {
  'Idempotency-Key': {
    description:
      'Optional, 8–64 chars `[A-Za-z0-9._-]`. A retry with the same key (same user, 24 h) replays the first response; a retry while the first call is still running → 409.',
    schema: { type: 'string', pattern: '^[A-Za-z0-9._-]{8,64}$', example: 'addr-create-7f3a9c21' },
  },
};

/** Example ids (UUID v7). */
export const IDS = {
  customer: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9c01',
  address: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9a01',
  address2: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9a02',
  product: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9e01',
  wish: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9b01',
  audit: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9d01',
} as const;

export const ok = (data: unknown, meta?: unknown) => ({
  success: true,
  data,
  ...(meta === undefined ? {} : { meta }),
});
