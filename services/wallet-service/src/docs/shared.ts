/** Swagger text shared by every wallet-service feature (docs only; no runtime use). */

export const AUTH_CUSTOMER =
  'Bearer access token of a `CUSTOMER` with full scope. A customer only ever sees their own wallet.';

export const ok = (data: unknown, meta?: unknown) => ({
  success: true,
  data,
  ...(meta === undefined ? {} : { meta }),
});

export const AUTH_ADMIN =
  'Bearer access token of an `INTERNAL` (staff) user with full scope (MFA done) **and** the permission below. Customers and staff without it get 403.';
