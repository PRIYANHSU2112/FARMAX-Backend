/** Swagger text shared by every notification-service feature (docs only; no runtime use). */

export const AUTH_USER =
  "Bearer access token of ANY signed-in user (customer, staff, logistics partner, vendor) with full scope. Only the caller's own inbox, preferences and devices are reachable: another user's id answers 404 (existence is never revealed). The `app` is checked against the token's user type.";
export const AUTH_ADMIN =
  'Bearer access token of an `INTERNAL` (staff) user with full scope (MFA done) **and** the permission below. Others get 403.';

/** Example ids (UUID v7). */
export const IDS = {
  notification: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a01',
  device: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7b01',
  order: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9f01',
  user: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e31',
} as const;

export const ok = (data: unknown, meta?: unknown) => ({
  success: true,
  data,
  ...(meta === undefined ? {} : { meta }),
});
