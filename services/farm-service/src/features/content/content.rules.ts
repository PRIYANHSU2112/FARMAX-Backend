import { createHash } from 'node:crypto';

import type {
  Area,
  Block,
  ContentFields,
  ContentKind,
  ContentRow,
  ContentStatus,
  DistanceBucket,
  SyncAction,
} from './content.types.js';

/** Pure content rules: lifecycle, publish gates, separation of duties, derived fields. */

export const CONTENT_LIMITS = {
  /** An alert is live at most this long without an `extend` (and a fresh sign-off). */
  maxAlertDays: 30,
  defaultAlertDays: 14,
  /** A clinical sign-off older than this must be renewed before an extension. */
  signOffMaxAgeDays: 30,
  maxOfflinePerUser: 50,
  maxSavesPerUser: 500,
  /** EXPIRED copies stay readable offline (with a banner) this long, then are deleted. */
  endedOfflineDays: 7,
  /** Offline copies must be re-validated with `/library/sync` within this many days. */
  revalidateDays: 7,
  wordsPerMinute: 200,
} as const;

const DAY_MS = 86_400_000;

// ── Lifecycle ──

const TRANSITIONS: Readonly<Record<ContentStatus, readonly ContentStatus[]>> = {
  DRAFT: ['IN_REVIEW', 'ARCHIVED'],
  IN_REVIEW: ['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED'],
  SCHEDULED: ['PUBLISHED', 'ARCHIVED'],
  PUBLISHED: ['EXPIRED', 'RETRACTED', 'ARCHIVED'],
  EXPIRED: ['PUBLISHED', 'RETRACTED', 'ARCHIVED'],
  RETRACTED: [],
  ARCHIVED: ['DRAFT'],
};

export const canTransition = (from: ContentStatus, to: ContentStatus): boolean =>
  TRANSITIONS[from].includes(to);

/** Statuses a reader can open (feed shows PUBLISHED only). */
export const READABLE: readonly ContentStatus[] = ['PUBLISHED', 'EXPIRED', 'RETRACTED'];

/** ALERTs and clinical topics need a verified vet sign-off and ≥ 1 source. */
export const isClinical = (kind: ContentKind, topic: { clinical: boolean }): boolean =>
  kind === 'ALERT' || topic.clinical;

// ── Separation of duties ──

/** Everyone who wrote the reader-visible content (they may not approve or sign it off). */
export const authorsOf = (
  item: Pick<ContentRow, 'createdByUserId' | 'updatedByUserId' | 'submittedByUserId'>,
): Set<string> => {
  const ids = new Set([item.createdByUserId, item.updatedByUserId]);
  if (item.submittedByUserId !== null) ids.add(item.submittedByUserId);
  return ids;
};

// ── Sign-off binding ──

type Hashed = Pick<
  ContentFields,
  | 'title'
  | 'summary'
  | 'heroImageUrl'
  | 'blocks'
  | 'sources'
  | 'ctas'
  | 'asset'
  | 'severity'
  | 'placeLabel'
> & { kind: ContentKind };

/** Stable hash of what the reviewer vouched for: any later change of these voids the sign-off. */
export const contentHash = (c: Hashed): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        c.kind,
        c.title,
        c.summary,
        c.heroImageUrl,
        c.blocks,
        c.sources,
        c.ctas,
        c.asset,
        c.severity,
        c.placeLabel,
      ]),
    )
    .digest('hex');

// ── Publish gates ──

export interface GateIssue {
  code:
    | 'SOURCE_REQUIRED'
    | 'EXPIRY_REQUIRED'
    | 'EXPIRY_TOO_FAR'
    | 'EXPIRY_IN_PAST'
    | 'SEVERITY_REQUIRED'
    | 'PLACE_REQUIRED'
    | 'SIGNOFF_REQUIRED'
    | 'SIGNOFF_STALE'
    | 'REVIEWER_INVALID'
    | 'BODY_REQUIRED'
    | 'ASSET_REQUIRED';
  message: string;
}

export interface GateContext {
  now: Date;
  /** When it goes live (scheduled) — default now. */
  goLiveAt?: Date;
  /** Skip sign-off checks (submit runs the other checks early). */
  skipSignOff?: boolean;
  /** The signing reviewer is active and unexpired. */
  reviewerValid: boolean;
}

/** Everything that blocks publishing (empty = may publish). */
export const publishBlockers = (item: ContentRow, ctx: GateContext): GateIssue[] => {
  const issues: GateIssue[] = [];
  const goLive = ctx.goLiveAt ?? ctx.now;
  if (item.blocks.length === 0 && item.asset === null)
    issues.push({ code: 'BODY_REQUIRED', message: 'Add body blocks or an asset' });
  if (item.kind === 'VIDEO' && item.asset?.kind !== 'video')
    issues.push({ code: 'ASSET_REQUIRED', message: 'A VIDEO item needs a video asset' });
  if (item.kind === 'ALERT') {
    if (item.severity === null)
      issues.push({ code: 'SEVERITY_REQUIRED', message: 'Set the alert severity' });
    if (item.placeLabel === null)
      issues.push({ code: 'PLACE_REQUIRED', message: 'Set the affected area (place label)' });
    if (item.expiresAt === null) {
      issues.push({ code: 'EXPIRY_REQUIRED', message: 'An alert needs an expiry date' });
    } else {
      const expires = new Date(item.expiresAt).getTime();
      if (expires <= goLive.getTime())
        issues.push({ code: 'EXPIRY_IN_PAST', message: 'The expiry must be after go-live' });
      if (expires > goLive.getTime() + CONTENT_LIMITS.maxAlertDays * DAY_MS)
        issues.push({
          code: 'EXPIRY_TOO_FAR',
          message: `An alert may run at most ${String(CONTENT_LIMITS.maxAlertDays)} days`,
        });
    }
  }
  if (isClinical(item.kind, item.topic)) {
    if (item.sources.length === 0)
      issues.push({ code: 'SOURCE_REQUIRED', message: 'Cite at least one source' });
    if (ctx.skipSignOff !== true) {
      if (item.reviewer === null || item.signedOffHash === null)
        issues.push({ code: 'SIGNOFF_REQUIRED', message: 'A verified vet must sign this off' });
      else if (item.signedOffHash !== contentHash(item))
        issues.push({
          code: 'SIGNOFF_STALE',
          message: 'The content changed after sign-off: sign it off again',
        });
      else if (!ctx.reviewerValid)
        issues.push({
          code: 'REVIEWER_INVALID',
          message: 'The signing reviewer is inactive or their registration expired',
        });
    }
  }
  return issues;
};

/** Latest allowed expiry for an alert going live / extended at `from`. */
export const maxExpiry = (from: Date): Date =>
  new Date(from.getTime() + CONTENT_LIMITS.maxAlertDays * DAY_MS);

export const defaultExpiry = (from: Date): Date =>
  new Date(from.getTime() + CONTENT_LIMITS.defaultAlertDays * DAY_MS);

export const signOffFresh = (signedOffAt: string | null, now: Date): boolean =>
  signedOffAt !== null &&
  now.getTime() - new Date(signedOffAt).getTime() <= CONTENT_LIMITS.signOffMaxAgeDays * DAY_MS;

// ── Derived fields ──

const blockText = (b: Block): string => {
  switch (b.type) {
    case 'heading':
    case 'paragraph':
    case 'callout':
      return b.text;
    case 'list':
      return b.items.join(' ');
    case 'image':
      return b.caption ?? '';
    case 'video':
      return '';
  }
};

/** Search text (tags + body) and reading time. */
export const derive = (
  blocks: readonly Block[],
  tags: readonly string[],
  summary: string,
  durationSec: number | null,
): { bodyText: string; readMinutes: number } => {
  const body = blocks
    .map(blockText)
    .filter((t) => t !== '')
    .join('\n');
  const words = `${summary} ${body}`.split(/\s+/).filter((w) => w !== '').length;
  const reading = Math.ceil(words / CONTENT_LIMITS.wordsPerMinute);
  const watching = durationSec === null ? 0 : Math.ceil(durationSec / 60);
  return {
    bodyText: [tags.join(' '), body].filter((t) => t !== '').join('\n'),
    readMinutes: Math.min(Math.max(reading, watching, 1), 600),
  };
};

/** Area centre rounded to 2 decimals (~1 km): never precise enough to point at a farm. */
export const roundArea = (area: Area | null): Area | null =>
  area === null
    ? null
    : { lat: Math.round(area.lat * 100) / 100, lng: Math.round(area.lng * 100) / 100 };

/** `newcastle-disease-on-3-farms-near-tanuku-0a1b2c` (title + 6 hex of the id). */
export const slugify = (title: string, id: string): string => {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '');
  const suffix = id.replaceAll('-', '').slice(-6);
  return base === '' ? suffix : `${base}-${suffix}`;
};

/** Content image / asset URLs must come from media-service (https only when unconfigured). */
export const isMediaUrl = (url: string, mediaBaseUrl: string | undefined): boolean => {
  if (mediaBaseUrl !== undefined && mediaBaseUrl !== '') {
    const base = mediaBaseUrl.endsWith('/') ? mediaBaseUrl : `${mediaBaseUrl}/`;
    return url.startsWith(base);
  }
  return url.startsWith('https://');
};

// ── Location privacy ──

const EARTH_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in km. */
export const haversineKm = (a: Area, b: Area): number => {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
};

/** Distance as a coarse bucket: a reader's position can never be triangulated from it. */
export const distanceBucket = (
  reader: { lat: number | null; lng: number | null } | null,
  area: Area | null,
): DistanceBucket | null => {
  if (reader?.lat == null || reader.lng == null || area === null) return null;
  const km = haversineKm({ lat: reader.lat, lng: reader.lng }, area);
  if (km < 5) return '<5 km';
  if (km < 10) return '5–10 km';
  if (km < 25) return '10–25 km';
  if (km < 50) return '25–50 km';
  return '50+ km';
};

// ── Offline sync ──

/**
 * What a device must do with an offline copy.
 *   held = version on the device (null: not held); saved = still saved offline by the reader.
 */
export const syncAction = (
  held: number | null,
  saved: boolean,
  item: Pick<ContentRow, 'status' | 'contentVersion' | 'expiredAt'> | null,
  now: Date,
): SyncAction | null => {
  if (item === null || !saved) return held === null ? null : 'DELETE';
  switch (item.status) {
    case 'RETRACTED':
    case 'ARCHIVED':
    case 'DRAFT':
    case 'IN_REVIEW':
    case 'SCHEDULED':
      return held === null ? null : 'DELETE';
    case 'EXPIRED': {
      const endedLongAgo =
        item.expiredAt !== null &&
        now.getTime() - new Date(item.expiredAt).getTime() >
          CONTENT_LIMITS.endedOfflineDays * DAY_MS;
      if (endedLongAgo) return held === null ? null : 'DELETE';
      return held === null ? null : 'MARK_ENDED';
    }
    case 'PUBLISHED':
      if (held === null) return 'DOWNLOAD';
      return held === item.contentVersion ? 'KEEP' : 'REPLACE';
  }
};
