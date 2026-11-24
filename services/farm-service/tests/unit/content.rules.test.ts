import { describe, expect, it } from 'vitest';

import {
  authorsOf,
  canTransition,
  contentHash,
  derive,
  distanceBucket,
  isMediaUrl,
  publishBlockers,
  roundArea,
  slugify,
  syncAction,
} from '../../src/features/content/content.rules.js';
import type { ContentRow } from '../../src/features/content/content.types.js';

const NOW = new Date('2026-11-20T10:00:00.000Z');
const DAY = 86_400_000;

const alert = (over: Partial<ContentRow> = {}): ContentRow => ({
  id: '01900000-0000-7000-8000-0000000000c1',
  slug: 'nd-tanuku',
  kind: 'ALERT',
  topic: { id: 't', code: 'DISEASE', name: 'Disease', clinical: true },
  title: 'Newcastle disease near Tanuku',
  summary: 'Confirmed in 3 flocks.',
  heroImageUrl: null,
  heroMediaId: null,
  blocks: [{ type: 'paragraph', text: 'Stop visitors at the gate.' }],
  sources: [{ title: 'Bulletin', publisher: 'AHD', url: null, referenceDate: '2026-11-18' }],
  ctas: [],
  tags: [],
  relatedIds: [],
  asset: null,
  severity: 'WARNING',
  placeLabel: 'Tanuku',
  area: { lat: 16.75, lng: 81.68 },
  productionTypes: [],
  territoryCodes: [],
  readMinutes: 1,
  reviewer: { id: 'r', displayName: 'Dr. K', qualification: 'BVSc', registrationNo: 'AP-1' },
  clinicalSignedOffAt: NOW.toISOString(),
  signedOffHash: null,
  status: 'IN_REVIEW',
  isFeatured: false,
  notify: true,
  publishAt: null,
  publishedAt: null,
  expiresAt: new Date(NOW.getTime() + 14 * DAY).toISOString(),
  expiredAt: null,
  retractedAt: null,
  retractNote: null,
  notifiedAt: null,
  lastCorrectedAt: null,
  correctionNote: null,
  contentVersion: 1,
  version: 3,
  viewCount: 0,
  helpfulYes: 0,
  helpfulNo: 0,
  saveCount: 0,
  shareCount: 0,
  trendingScore: 0,
  createdByUserId: 'author',
  updatedByUserId: 'editor',
  submittedByUserId: 'submitter',
  submittedAt: null,
  publishedByUserId: null,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  ...over,
});

const signed = (over: Partial<ContentRow> = {}) => {
  const item = alert(over);
  return { ...item, signedOffHash: contentHash(item) };
};
const codes = (item: ContentRow, ctx: Partial<Parameters<typeof publishBlockers>[1]> = {}) =>
  publishBlockers(item, { now: NOW, reviewerValid: true, ...ctx }).map((i) => i.code);

describe('content lifecycle', () => {
  it('allows only the defined transitions', () => {
    expect(canTransition('DRAFT', 'IN_REVIEW')).toBe(true);
    expect(canTransition('IN_REVIEW', 'PUBLISHED')).toBe(true);
    expect(canTransition('PUBLISHED', 'RETRACTED')).toBe(true);
    expect(canTransition('EXPIRED', 'PUBLISHED')).toBe(true); // extend
    expect(canTransition('DRAFT', 'PUBLISHED')).toBe(false); // no skipping review
    expect(canTransition('RETRACTED', 'PUBLISHED')).toBe(false); // final
    expect(canTransition('PUBLISHED', 'DRAFT')).toBe(false); // corrections, not edits
  });

  it('treats creator, last editor and submitter as authors (SoD)', () => {
    expect([...authorsOf(alert())].sort()).toEqual(['author', 'editor', 'submitter']);
  });
});

describe('publish gates (alert accuracy)', () => {
  it('a signed, sourced alert with a ≤ 30-day expiry may publish', () => {
    expect(codes(signed())).toEqual([]);
  });

  it('requires sources, severity, place, expiry and a sign-off on alerts', () => {
    const item = alert({ sources: [], severity: null, placeLabel: null, expiresAt: null });
    expect(codes(item)).toEqual(
      expect.arrayContaining([
        'SOURCE_REQUIRED',
        'SEVERITY_REQUIRED',
        'PLACE_REQUIRED',
        'EXPIRY_REQUIRED',
        'SIGNOFF_REQUIRED',
      ]),
    );
  });

  it('rejects an expiry past 30 days or before go-live', () => {
    const far = signed({ expiresAt: new Date(NOW.getTime() + 31 * DAY).toISOString() });
    expect(codes(far)).toContain('EXPIRY_TOO_FAR');
    const past = signed({ expiresAt: new Date(NOW.getTime() - DAY).toISOString() });
    expect(codes(past)).toContain('EXPIRY_IN_PAST');
    // Scheduled go-live after the expiry is also refused.
    const item = signed();
    expect(codes(item, { goLiveAt: new Date(NOW.getTime() + 20 * DAY) })).toContain(
      'EXPIRY_IN_PAST',
    );
  });

  it('voids the sign-off when the reviewed text changes', () => {
    const item = signed();
    expect(codes({ ...item, title: 'Edited after sign-off' })).toContain('SIGNOFF_STALE');
    expect(codes({ ...item, blocks: [{ type: 'paragraph', text: 'New advice' }] })).toContain(
      'SIGNOFF_STALE',
    );
    // Targeting / tags are not reviewed text.
    expect(codes({ ...item, territoryCodes: ['WG'], tags: ['nd'] })).toEqual([]);
  });

  it('blocks when the signing reviewer is inactive or expired', () => {
    expect(codes(signed(), { reviewerValid: false })).toContain('REVIEWER_INVALID');
  });

  it('non-clinical news needs no sign-off or sources', () => {
    const news = alert({
      kind: 'NEWS',
      topic: { id: 't2', code: 'REGULATION', name: 'Regulation', clinical: false },
      sources: [],
      reviewer: null,
      severity: null,
      placeLabel: null,
      expiresAt: null,
    });
    expect(codes(news)).toEqual([]);
  });
});

describe('derived fields and privacy', () => {
  it('reading time from words (≥ 1) or video length', () => {
    const words = Array.from({ length: 450 }, () => 'word').join(' ');
    expect(derive([{ type: 'paragraph', text: words }], [], '', null).readMinutes).toBe(3);
    expect(derive([], [], 'short', 300).readMinutes).toBe(5);
    expect(derive([], ['nd', 'vaccine'], '', null).bodyText).toBe('nd vaccine');
  });

  it('rounds alert areas to ~1 km', () => {
    expect(roundArea({ lat: 16.754321, lng: 81.681234 })).toEqual({ lat: 16.75, lng: 81.68 });
  });

  it('returns only distance buckets, never coordinates', () => {
    const area = { lat: 16.75, lng: 81.68 };
    expect(distanceBucket({ lat: 16.75, lng: 81.69 }, area)).toBe('<5 km');
    expect(distanceBucket({ lat: 16.85, lng: 81.68 }, area)).toBe('10–25 km');
    expect(distanceBucket({ lat: 17.75, lng: 81.68 }, area)).toBe('50+ km');
    expect(distanceBucket(null, area)).toBeNull();
    expect(distanceBucket({ lat: null, lng: null }, area)).toBeNull();
  });

  it('accepts media only from media-service', () => {
    expect(isMediaUrl('https://cdn.farmx.in/media/a.jpg', 'https://cdn.farmx.in/media')).toBe(true);
    expect(isMediaUrl('https://evil.example/a.jpg', 'https://cdn.farmx.in/media')).toBe(false);
    expect(isMediaUrl('http://x/a.jpg', undefined)).toBe(false);
  });

  it('builds readable, unique slugs', () => {
    expect(slugify('Newcastle disease on 3 farms near Tanuku!', '0190-abcdef123456')).toBe(
      'newcastle-disease-on-3-farms-near-tanuku-123456',
    );
  });
});

describe('offline sync actions', () => {
  const live = { status: 'PUBLISHED' as const, contentVersion: 3, expiredAt: null };
  it('keeps current copies, replaces stale ones, downloads missing ones', () => {
    expect(syncAction(3, true, live, NOW)).toBe('KEEP');
    expect(syncAction(2, true, live, NOW)).toBe('REPLACE');
    expect(syncAction(null, true, live, NOW)).toBe('DOWNLOAD');
  });

  it('deletes withdrawn, archived and unsaved copies', () => {
    expect(syncAction(3, true, { ...live, status: 'RETRACTED' }, NOW)).toBe('DELETE');
    expect(syncAction(3, true, { ...live, status: 'ARCHIVED' }, NOW)).toBe('DELETE');
    expect(syncAction(3, false, live, NOW)).toBe('DELETE');
    expect(syncAction(3, true, null, NOW)).toBe('DELETE');
    expect(syncAction(null, false, live, NOW)).toBeNull();
  });

  it('marks ended alerts for 7 days, then deletes them', () => {
    const ended = { ...live, status: 'EXPIRED' as const };
    const recent = { ...ended, expiredAt: new Date(NOW.getTime() - 2 * DAY).toISOString() };
    const old = { ...ended, expiredAt: new Date(NOW.getTime() - 8 * DAY).toISOString() };
    expect(syncAction(3, true, recent, NOW)).toBe('MARK_ENDED');
    expect(syncAction(3, true, old, NOW)).toBe('DELETE');
    expect(syncAction(null, true, recent, NOW)).toBeNull();
  });
});
