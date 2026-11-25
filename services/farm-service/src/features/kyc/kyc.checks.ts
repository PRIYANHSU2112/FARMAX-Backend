/** Offline identifier checks: reject typos before any paid provider call. Pure functions. */

const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Aadhaar: 12 digits, not starting with 0/1, valid Verhoeff check digit. */
export function isValidAadhaar(value: string): boolean {
  if (!/^[2-9][0-9]{11}$/.test(value)) return false;
  let c = 0;
  const digits = Array.from({ length: value.length }, (_, i) =>
    Number(value.charAt(value.length - 1 - i)),
  );
  digits.forEach((digit, i) => {
    c = D[c]?.[P[i % 8]?.[digit] ?? 0] ?? 0;
  });
  return c === 0;
}

/** PAN: AAAAA9999A, 4th char = holder type (P person, C company, F firm, H HUF, …). */
export const PAN_PATTERN = /^[A-Z]{3}[PCHFATBLJG][A-Z][0-9]{4}[A-Z]$/;

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** GSTIN: state(2) + PAN(10) + entity(1) + Z + check char (mod-36 checksum). */
export function isValidGstin(value: string): boolean {
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = CHARS.indexOf(value.charAt(i)) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS.charAt((36 - (sum % 36)) % 36) === value.charAt(14);
}

export const maskPan = (pan: string): string => `${pan.slice(0, 5)}****${pan.slice(-1)}`;

/** Loose name match for provider results: any shared word of ≥ 3 letters (initials vary). */
/**
 * Strict business-name equality for invoices (case, spacing and punctuation ignored):
 * "Sri Lakshmi Agro Farms" ≠ "Sri Lakshmi Poultry". A GST invoice must carry the registered name,
 * so anything else is "doesn't match" and needs a review to invoice under the farm name.
 */
export function sameBusinessName(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  return norm(a) !== '' && norm(a) === norm(b);
}

export function namesMatch(a: string, b: string): boolean {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3),
    );
  const left = words(a);
  return [...words(b)].some((w) => left.has(w));
}
