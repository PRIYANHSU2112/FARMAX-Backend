/** Swagger text shared by every call-service feature (docs only; no runtime use). */

export const AUTH_ADMIN =
  'Bearer access token of an `INTERNAL` (staff) user with full scope **and** the permission below.';
export const AUTH_CUSTOMER =
  'Bearer access token of a `CUSTOMER` with full scope. Farms and bookings are owner-only; any other id answers 404.';
export const AUTH_EXPERT =
  'Bearer access token of a staff or vendor user who has an **active expert profile**. Only the expert\'s own profile, availability and queue.';

/** Example ids (UUID v7). */
export const IDS = {
  expert: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d6a01',
  expertUser: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d6a02',
  product: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d6b01',
  brand: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d6b02',
  category: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d6b03',
  farm: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d6c01',
  option: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d6d01',
  timeOff: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d6e01',
  holiday: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d6e02',
} as const;

export const ok = (data: unknown, meta?: unknown) => ({
  success: true,
  data,
  ...(meta === undefined ? {} : { meta }),
});
