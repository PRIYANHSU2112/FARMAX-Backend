/** Swagger text shared by every payment-service feature (docs only; no runtime use). */

export const AUTH_ADMIN =
  'Bearer access token of an `INTERNAL` (staff) user with full scope (MFA done) **and** the permission below. Customers and staff without it get 403.';
export const AUTH_CUSTOMER =
  'Bearer access token of a `CUSTOMER` with full scope. Only the buyer of the order may see or act on its payment; any other id answers 404 (existence is never revealed).';

/** Example ids (UUID v7). */
export const IDS = {
  payment: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9e01',
  refund: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9e02',
  order: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9f01',
  admin: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e31',
} as const;

export const ok = (data: unknown, meta?: unknown) => ({
  success: true,
  data,
  ...(meta === undefined ? {} : { meta }),
});
