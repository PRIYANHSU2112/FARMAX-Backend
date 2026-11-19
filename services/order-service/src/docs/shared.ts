/** Swagger text shared by every order-service feature (docs only; no runtime use). */

export const AUTH_ADMIN =
  'Bearer access token of an `INTERNAL` (staff) user with full scope (MFA done) **and** the permission below. Customers and staff without it get 403.';
export const AUTH_CUSTOMER =
  'Bearer access token of a `CUSTOMER` with full scope. The farm must be **ACTIVE and owned by the caller**; any other farm id answers 404 `Farm not found` (existence is never revealed).';

/** Example ids (UUID v7). */
export const IDS = {
  promotion: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9a01',
  promotion2: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9a02',
  bonus: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9a03',
  bundle: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9a04',
  monsoon: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9a05',
  retail: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9a06',
  categoryBiosecurity: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d6a07',
  farm: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d3f01',
  variant: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8b01',
  variant2: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8b02',
  admin: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e31',
  order: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9f01',
  address: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d4a01',
  payment: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9e01',
} as const;

export const ok = (data: unknown, meta?: unknown) => ({
  success: true,
  data,
  ...(meta === undefined ? {} : { meta }),
});
