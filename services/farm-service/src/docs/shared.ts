import type { DocHeader, ErrorExample } from '@farmx/common/server';

/** Swagger text and headers shared by every farm-service feature (docs only; no runtime use). */

export const AUTH_CUSTOMER =
  'Bearer access token of a `CUSTOMER` user with full scope (MFA done). Only the caller’s own farms are visible; another owner’s farm id answers 404, never 403.';
export const AUTH_ADMIN =
  'Bearer access token of an `INTERNAL` (staff) user with full scope (MFA done) **and** the permission below. Customers and staff without it get 403.';
export const AUTH_PUBLIC =
  'None (public). Access is gated by the HMAC `sig` printed in the Farm-pass QR.';

/** Request headers. */
export const IF_MATCH: Record<string, DocHeader> = {
  'If-Match': {
    description:
      'Farm `version` from the last read (`3`, `"3"` or `W/"3"`). If it differs from the current version → 409 `FARM_VERSION_CONFLICT`. Optional, but recommended on every write.',
    schema: { type: 'string', example: '"4"' },
  },
};
export const IDEMPOTENCY_KEY: Record<string, DocHeader> = {
  'Idempotency-Key': {
    description:
      'Optional, 8–64 chars `[A-Za-z0-9._-]`. A retry with the same key (same user, 24 h) replays the first response; a retry while the first call is still running → 409. Other values are ignored.',
    schema: { type: 'string', pattern: '^[A-Za-z0-9._-]{8,64}$', example: 'reg-7f3a9c21' },
  },
};

/** Response headers. */
export const ETAG: Record<string, DocHeader> = {
  ETag: {
    description: 'Current farm `version`, quoted. Send it back as `If-Match` on the next write.',
    schema: { type: 'string', example: '"4"' },
  },
};

/** Error examples, with the exact messages the service returns. */
export const ERR = {
  farmNotFound: { message: 'Farm not found' },
  versionConflict: {
    summary: 'FARM_VERSION_CONFLICT (stale If-Match)',
    message: 'The farm was changed by someone else; reload and retry',
    details: { reason: 'FARM_VERSION_CONFLICT', currentVersion: 5 },
  },
  notEditable: {
    summary: 'FARM_STATE_INVALID (not DRAFT / NEEDS_ATTENTION)',
    message: 'This farm can no longer be edited here',
    details: { reason: 'FARM_STATE_INVALID', status: 'ACTIVE' },
  },
  farmClosed: {
    summary: 'FARM_STATE_INVALID (farm closed, rejected or merged)',
    message: 'This farm is closed',
    details: { reason: 'FARM_STATE_INVALID' },
  },
  idempotencyBusy: {
    summary: 'Same Idempotency-Key still in progress',
    message: 'A request with this Idempotency-Key is in progress',
  },
  sod: {
    summary: 'SOD_VIOLATION (you created or own this registration)',
    message: 'You cannot decide on a registration you created or own',
    details: { reason: 'SOD_VIOLATION' },
  },
  missingPermission: {
    summary: 'Missing persona or permission',
    message: 'You do not have permission to perform this action',
  },
  badId: {
    summary: 'Malformed path id',
    message: 'Validation failed',
    details: { issues: [{ path: 'params.id', message: '"id" must be a valid GUID' }] },
  },
  pinNotServiceable: {
    summary: 'Pin code not serviceable',
    message: 'Validation failed',
    details: {
      issues: [{ path: 'pinCode', message: 'FarmX does not deliver to this pin code yet' }],
    },
  },
  providerDown: (label: string) => ({
    summary: 'Provider unavailable (timeout or circuit open)',
    message: `${label} is unavailable, try again shortly`,
  }),
} satisfies Record<string, ErrorExample | ((label: string) => ErrorExample)>;

export const reasonIssue = {
  summary: 'Missing or short reason',
  message: 'Validation failed',
  details: {
    issues: [
      { path: 'body.reason', message: '"reason" length must be at least 10 characters long' },
    ],
  },
};

/** Example ids reused across examples (UUID v7). */
export const IDS = {
  farm: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e10',
  farm2: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e11',
  owner: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e20',
  owner2: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e21',
  user: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e30',
  admin: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e31',
  territory: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e01',
  node: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e02',
  node2: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e03',
  case: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e40',
  doc: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e50',
  gst: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e60',
  audit: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e70',
} as const;

export const ok = (data: unknown, meta?: unknown) => ({
  success: true,
  data,
  ...(meta === undefined ? {} : { meta }),
});
