/** Swagger text shared by every support-service feature (docs only; no runtime use). */

export const AUTH_PUBLIC = 'None (public, cached). Rate limited per IP.';
export const AUTH_REQUESTER =
  'Bearer access token (full scope) of a CUSTOMER, VENDOR, LOGISTICS_PARTNER or INTERNAL (warehouse) user. The app is derived from the user type: CUSTOMER→CUSTOMER, VENDOR→VENDOR, LOGISTICS_PARTNER→LOGISTICS, INTERNAL→WAREHOUSE. Tickets are owner-only; any other id answers 404.';
export const AUTH_ADMIN =
  'Bearer access token of an `INTERNAL` (staff) user with full scope **and** the permission below.';

/** Example ids (UUID v7). */
export const IDS = {
  ticket: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a01',
  message: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a02',
  topic: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a03',
  order: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a04',
  user: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a05',
  agent: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a06',
  faq: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a07',
  category: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a08',
  legal: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a09',
  rule: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a0a',
  calendar: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a0b',
} as const;

export const ok = (data: unknown, meta?: unknown) => ({
  success: true,
  data,
  ...(meta === undefined ? {} : { meta }),
});
