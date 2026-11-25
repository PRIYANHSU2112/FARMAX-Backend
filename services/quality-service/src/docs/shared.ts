/** Swagger text shared by every quality-service feature (docs only; no runtime use). */
import type { Audience } from '../middleware/guards.js';

export const AUTH_STAFF = (aud: Audience) =>
  aud === 'admin'
    ? 'Bearer access token of an `INTERNAL` (staff) user with full scope; the permission must be held **GLOBALLY** (admin panel).'
    : 'Bearer access token of an `INTERNAL` (staff) user with full scope; the permission may be held GLOBALLY or at a warehouse. Out-of-scope warehouses answer 404.';
export const AUTH_GLOBAL =
  'Bearer access token of an `INTERNAL` (staff) user with full scope; the permission must be held **GLOBALLY** on both panels.';
export const AUTH_CUSTOMER =
  'Bearer access token (full scope) of a `CUSTOMER`. Only consignments / units the caller received are visible; any other answers 404.';
export const AUTH_PUBLIC =
  'None (public). Rate limited per IP. Returns goods, batch, certificates and verdict only — never buyer, farm, order or delivery details.';

/** Tag of a feature on one audience (`Quality · Samples` / `Admin Quality · Samples`). */
export const tagOf = (aud: Audience, area: string) =>
  aud === 'admin' ? `Admin Quality · ${area}` : `Quality · ${area}`;

export const CUSTOMER_TAG = 'Certificates (customer app)';
export const PUBLIC_TAG = 'Verify (public)';

export const VERSION_HEADER = {
  description: 'Not used: send `expectedVersion` in the body (optimistic lock).',
};
export const IDEMPOTENCY_HEADER = {
  'Idempotency-Key': {
    description:
      'Required. 8–64 chars [A-Za-z0-9_.:-]. A replay with the same key returns the first result and never acts twice.',
    required: true,
  },
};

/** Example ids (UUID v7). */
export const IDS = {
  batch: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8b01',
  variant: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8b02',
  warehouse: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8b03',
  lab: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8b04',
  sample: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8b05',
  coa: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8b06',
  decision: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8b07',
  receipt: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8b08',
  user: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8b09',
} as const;

/** Common 409 examples. */
export const VERSION_CONFLICT = {
  summary: 'Someone else changed it first',
  message: 'This was changed by someone else; reload and try again',
  details: { reason: 'VERSION_CONFLICT', currentVersion: 4 },
};
