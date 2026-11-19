import { describe, expect, it } from 'vitest';

import {
  compile,
  etagOf,
  isLive,
  responseEtag,
  selectPlacements,
  toPublic,
} from '../../src/features/banners/banners.service.js';
import type {
  SnapshotBanner,
  SnapshotPlacement,
} from '../../src/features/banners/banners.types.js';
import {
  createBannerSchema,
  createPlacementSchema,
  updateBannerSchema,
} from '../../src/features/banners/banners.validation.js';

const NOW = Date.UTC(2026, 11, 10);
const DAY = 86_400_000;
const P1 = '01900000-0000-7000-8000-000000000301';
const CAT = '01900000-0000-7000-8000-000000000401';

const banner = (id: string, extra: Partial<SnapshotBanner> = {}): SnapshotBanner => ({
  id,
  title: id,
  subtitle: null,
  imageUrl: 'https://cdn.farmx.in/b.webp',
  mobileImageUrl: null,
  actionType: 'NONE',
  actionTarget: null,
  sortOrder: 0,
  startsAt: null,
  endsAt: null,
  version: 0,
  ...extra,
});
const placement = (
  code: string,
  app: string,
  page: string,
  position: string,
  banners: SnapshotBanner[],
  maxItems = 5,
): SnapshotPlacement => ({
  id: `${code}-id`,
  code,
  app,
  page,
  position,
  aspectRatio: '16:9',
  maxItems,
  version: 0,
  banners,
});

describe('isLive (schedule window [start, end))', () => {
  it('open-ended, inside, before start, at end', () => {
    expect(isLive({ startsAt: null, endsAt: null }, NOW)).toBe(true);
    expect(isLive({ startsAt: NOW - DAY, endsAt: NOW + DAY }, NOW)).toBe(true);
    expect(isLive({ startsAt: NOW, endsAt: null }, NOW)).toBe(true);
    expect(isLive({ startsAt: NOW + 1, endsAt: null }, NOW)).toBe(false);
    expect(isLive({ startsAt: null, endsAt: NOW }, NOW)).toBe(false);
  });
});

describe('toPublic / selectPlacements', () => {
  const hero = placement(
    'FARMER_HOME_HERO',
    'FARMER',
    'HOME',
    'HERO_SLIDER',
    [
      banner('a'),
      banner('scheduled', { startsAt: NOW + DAY }),
      banner('b'),
      banner('expired', { endsAt: NOW - 1 }),
      banner('c'),
    ],
    2,
  );
  const strip = placement('FARMER_HOME_STRIP', 'FARMER', 'HOME', 'MID_STRIP', [banner('d')]);
  const cart = placement('FARMER_CHECKOUT_POPUP', 'FARMER', 'CHECKOUT', 'POPUP', []);
  const wh = placement('WH_HOME_HERO', 'WAREHOUSE', 'HOME', 'HERO_SLIDER', [banner('e')]);
  const snap = compile({ placements: [hero, strip, cart, wh], etag: 'W/"x"' });

  it('skips non-live banners and caps at maxItems, keeping order', () => {
    expect(toPublic(hero, NOW).banners.map((b) => b.id)).toEqual(['a', 'b']);
  });

  it('public banner has no schedule/version fields', () => {
    expect(Object.keys(toPublic(strip, NOW).banners[0]!)).not.toContain('version');
  });

  it('filters by app, page, position', () => {
    const codes = (q: Parameters<typeof selectPlacements>[1]) =>
      selectPlacements(snap, q, NOW).map((p) => p.code);
    expect(codes({ app: 'FARMER' })).toEqual([
      'FARMER_HOME_HERO',
      'FARMER_HOME_STRIP',
      'FARMER_CHECKOUT_POPUP',
    ]);
    expect(codes({ app: 'FARMER', page: 'HOME' })).toEqual([
      'FARMER_HOME_HERO',
      'FARMER_HOME_STRIP',
    ]);
    expect(codes({ app: 'FARMER', page: 'HOME', position: 'MID_STRIP' })).toEqual([
      'FARMER_HOME_STRIP',
    ]);
    expect(codes({ app: 'LOGISTICS' })).toEqual([]);
    expect(snap.byCode.get('WH_HOME_HERO')?.app).toBe('WAREHOUSE');
  });

  it('response ETag changes when a scheduled banner goes live', () => {
    const before = selectPlacements(snap, { app: 'FARMER', page: 'HOME' }, NOW);
    const after = selectPlacements(snap, { app: 'FARMER', page: 'HOME' }, NOW + 2 * DAY);
    expect(responseEtag(snap.etag, before)).not.toBe(responseEtag(snap.etag, after));
    expect(responseEtag(snap.etag, before)).toBe(responseEtag(snap.etag, before));
  });

  it('snapshot ETag changes with any version', () => {
    const bumped = { ...strip, banners: [banner('d', { version: 1 })] };
    expect(etagOf([hero, strip])).not.toBe(etagOf([hero, bumped]));
  });
});

describe('Joi rules', () => {
  const base = {
    placementId: P1,
    title: 'Sale',
    imageUrl: 'https://cdn.farmx.in/x.webp',
    reason: 'campaign banner',
  };
  const check = (body: object) => createBannerSchema.body.validate(body).error?.message;

  it('actionTarget follows actionType', () => {
    expect(check(base)).toBeUndefined();
    expect(check({ ...base, actionType: 'CATEGORY', actionTarget: CAT })).toBeUndefined();
    expect(check({ ...base, actionType: 'CATEGORY', actionTarget: 'nope' })).toBeDefined();
    expect(check({ ...base, actionType: 'CATEGORY' })).toBeDefined();
    expect(
      check({ ...base, actionType: 'EXTERNAL_URL', actionTarget: 'https://farmx.in/x' }),
    ).toBeUndefined();
    expect(
      check({ ...base, actionType: 'EXTERNAL_URL', actionTarget: 'http://farmx.in/x' }),
    ).toBeDefined();
    expect(
      check({ ...base, actionType: 'DEEP_LINK', actionTarget: 'farmx://product/123' }),
    ).toBeUndefined();
    expect(check({ ...base, actionType: 'NONE', actionTarget: 'x' })).toBeDefined();
    expect(check({ ...base, actionType: 'POPUP' })).toBeDefined();
  });

  it('endDate must be after startDate', () => {
    expect(
      check({ ...base, startDate: '2026-12-10T00:00:00Z', endDate: '2026-12-01T00:00:00Z' }),
    ).toBeDefined();
    expect(
      check({ ...base, startDate: '2026-12-01T00:00:00Z', endDate: '2026-12-10T00:00:00Z' }),
    ).toBeUndefined();
  });

  it('update needs actionType and actionTarget together', () => {
    const v = (body: object) => updateBannerSchema.body.validate(body).error?.message;
    expect(v({ actionType: 'CATEGORY', reason: 'retarget banner' })).toBeDefined();
    expect(
      v({ actionType: 'CATEGORY', actionTarget: CAT, reason: 'retarget banner' }),
    ).toBeUndefined();
  });

  it('placement keys are upper-cased; bad code rejected', () => {
    const result: { value: Record<string, unknown>; error?: unknown } =
      createPlacementSchema.body.validate({
        code: 'farmer_home_hero',
        name: 'Hero',
        app: 'farmer',
        page: 'home',
        position: 'hero_slider',
        aspectRatio: '16:9',
        reason: 'new slot for home',
      });
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      code: 'FARMER_HOME_HERO',
      app: 'FARMER',
      position: 'HERO_SLIDER',
    });
    expect(
      createPlacementSchema.body.validate({ ...result.value, code: 'BAD CODE!' }).error,
    ).toBeDefined();
  });
});
