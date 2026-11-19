/** Swagger text shared by every inventory-service feature (docs only; no runtime use). */
import type { DocHeader } from '@farmx/common/server';

export const AUTH_ADMIN =
  'Bearer access token of an `INTERNAL` (staff) user with full scope (MFA done) **and** the permission below. Customers, vendors and staff without it get 403. Permissions are GLOBAL (central inventory administration); warehouse-scoped grants come with the WMS phase.';

export const IDEMPOTENCY: Record<string, DocHeader> = {
  'Idempotency-Key': {
    required: true,
    description:
      '8–64 chars `[A-Za-z0-9._:-]`. Stored in the database with the movement: a retry with the same key and body returns the ORIGINAL result (no second movement); the same key with a different body → 422.',
    schema: { type: 'string', pattern: '^[A-Za-z0-9._:-]{8,64}$', example: 'grn-2026-11-20-0001' },
  },
};

export const IF_VERSION =
  '`expectedVersion` from the last read is required; a stale version → 409 `VERSION_CONFLICT`.';

/** Example ids (UUID v7). */
export const IDS = {
  warehouse: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a01',
  depot: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a02',
  variant: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8b01',
  variant2: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8b02',
  operation: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7c01',
  reservation: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7d01',
  admin: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e31',
} as const;

export const ok = (data: unknown, meta?: unknown) => ({
  success: true,
  data,
  ...(meta === undefined ? {} : { meta }),
});
