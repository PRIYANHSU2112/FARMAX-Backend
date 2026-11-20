/**
 * Pure review rules: text sanitising, auto-moderation flags, author-name masking and the rating
 * summary delta. No I/O (unit-tested in isolation).
 */
import type { ReviewImage, ReviewStatus } from './reviews.types.js';

export const REVIEW_LIMITS = {
  titleMax: 120,
  bodyMax: 2000,
  maxImages: 5,
} as const;

/** Reasons a review waits for an admin (stored in `flags`). */
export type ReviewFlag =
  'IMAGES' | 'LINK' | 'PHONE' | 'EMAIL' | 'BANNED_WORD' | 'SHOUTING' | 'REPEATED' | 'REPORTS';

const CONTROL = new RegExp(
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]',
  'g',
);
const TAGS = /<[^>]*>/g;

/** Strip HTML and control / zero-width chars, collapse blanks, keep ≤ 2 line breaks. '' → null. */
export const sanitizeText = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null) return null;
  const clean = value
    .replace(TAGS, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clean === '' ? null : clean;
};

const LINK =
  /(https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(com|in|net|org|co|io|xyz|link|me|info|biz|app|shop)\b)/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
/** Indian mobile, with optional +91 / 0 and spaces or dashes between digits. */
const PHONE = /(?:\+?91|0)?[\s-]*[6-9](?:[\s-]*\d){9}(?!\d)/;
const REPEATED = /(.)\1{6,}/u;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compile the configured banned words / phrases once (whole-word, case-insensitive). */
export const compileBannedWords = (words: readonly string[]): RegExp | null => {
  const list = words.map((w) => w.trim().toLowerCase()).filter((w) => w.length > 0);
  if (list.length === 0) return null;
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])(${list.map(escapeRegex).join('|')})(?=$|[^\\p{L}\\p{N}])`,
    'iu',
  );
};

const isShouting = (text: string): boolean => {
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length < 20) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length > 0.7;
};

/** Auto-moderation: any flag → PENDING (admin approves); none → published at once. */
export const moderationFlags = (
  content: { title: string | null; body: string | null; hasImages: boolean },
  banned: RegExp | null,
): ReviewFlag[] => {
  const flags: ReviewFlag[] = [];
  if (content.hasImages) flags.push('IMAGES');
  const text = [content.title, content.body].filter((t) => t !== null).join('\n');
  if (text === '') return flags;
  if (LINK.test(text)) flags.push('LINK');
  if (EMAIL.test(text)) flags.push('EMAIL');
  if (PHONE.test(text)) flags.push('PHONE');
  if (banned?.test(text) === true) flags.push('BANNED_WORD');
  if (isShouting(text)) flags.push('SHOUTING');
  if (REPEATED.test(text)) flags.push('REPEATED');
  return flags;
};

export const initialStatus = (flags: readonly ReviewFlag[]): ReviewStatus =>
  flags.length > 0 ? 'PENDING' : 'PUBLISHED';

/**
 * Status after the author edits. A rejected review always goes back to an admin; otherwise the
 * fresh content decides (clean → published, flagged → pending).
 */
export const statusAfterEdit = (
  current: ReviewStatus,
  flags: readonly ReviewFlag[],
): ReviewStatus => (current === 'REJECTED' ? 'PENDING' : initialStatus(flags));

/** "ramesh kumar reddy" → "Ramesh R."; one word → "Ramesh"; nothing usable → fallback. */
export const maskName = (
  fullName: string | null | undefined,
  fallback = 'FarmX Customer',
): string => {
  const parts = (fullName ?? '')
    .replace(/[^\p{L}\s.'-]/gu, ' ')
    .split(/\s+/)
    .filter((p) => p.length > 0);
  const first = parts[0];
  if (first === undefined) return fallback;
  const cap = (s: string) =>
    s.charAt(0).toLocaleUpperCase('en-IN') + s.slice(1).toLocaleLowerCase('en-IN');
  const name = cap(first).slice(0, 40);
  const last = parts.length > 1 ? parts.at(-1) : undefined;
  return last === undefined ? name : `${name} ${last.charAt(0).toLocaleUpperCase('en-IN')}.`;
};

/** Image URLs must come from media-service (its public base), else plain https. */
export const isAllowedImageUrl = (url: string, mediaBaseUrl: string | undefined): boolean => {
  if (mediaBaseUrl !== undefined && mediaBaseUrl !== '') {
    const base = mediaBaseUrl.endsWith('/') ? mediaBaseUrl : `${mediaBaseUrl}/`;
    return url.startsWith(base);
  }
  return url.startsWith('https://');
};

export const dedupeImages = (images: readonly ReviewImage[]): ReviewImage[] => {
  const seen = new Set<string>();
  return images.filter((img) => (seen.has(img.mediaId) ? false : (seen.add(img.mediaId), true)));
};

// ── Rating summary ──

/** What one review adds to its product summary while PUBLISHED. */
export interface Contribution {
  rating: number;
  hasText: boolean;
  hasImages: boolean;
}

export interface SummaryDelta {
  count: number;
  sum: number;
  /** Index 0 = 1★ … 4 = 5★. */
  stars: [number, number, number, number, number];
  text: number;
  image: number;
}

export const contributionOf = (r: {
  status: ReviewStatus;
  deleted?: boolean;
  rating: number;
  title: string | null;
  body: string | null;
  hasImages: boolean;
}): Contribution | null =>
  r.status === 'PUBLISHED' && r.deleted !== true
    ? { rating: r.rating, hasText: r.title !== null || r.body !== null, hasImages: r.hasImages }
    : null;

/** after − before. Both null (or equal) → a zero delta. */
export const summaryDelta = (
  before: Contribution | null,
  after: Contribution | null,
): SummaryDelta => {
  const d: SummaryDelta = { count: 0, sum: 0, stars: [0, 0, 0, 0, 0], text: 0, image: 0 };
  const apply = (c: Contribution | null, sign: 1 | -1) => {
    if (c === null) return;
    d.count += sign;
    d.sum += sign * c.rating;
    d.stars[c.rating - 1] = (d.stars[c.rating - 1] ?? 0) + sign;
    if (c.hasText) d.text += sign;
    if (c.hasImages) d.image += sign;
  };
  apply(before, -1);
  apply(after, 1);
  return d;
};

export const isZeroDelta = (d: SummaryDelta): boolean =>
  d.count === 0 && d.sum === 0 && d.text === 0 && d.image === 0 && d.stars.every((s) => s === 0);

/** "4.35" (2 dp, half-up) or null when there is nothing to average. */
export const averageOf = (sum: number, count: number): string | null =>
  count <= 0 ? null : (Math.round((sum / count) * 100) / 100).toFixed(2);

/** Distribution 5★ → 1★ with whole-number percentages. */
export const distributionOf = (stars: readonly number[], count: number) =>
  ([5, 4, 3, 2, 1] as const).map((n) => {
    const c = stars[n - 1] ?? 0;
    return { stars: n, count: c, percent: count > 0 ? Math.round((c / count) * 100) : 0 };
  });
