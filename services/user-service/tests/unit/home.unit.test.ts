import { userKeys } from '@farmx/infra/redis';
import { describe, expect, it, vi } from 'vitest';

import { sduiOf } from '../../src/features/home/home.context.js';
import { checkLayout, hostAllowed } from '../../src/features/home/home.admin.service.js';
import {
  bucketOf,
  compileRule,
  compileSnapshot,
  langOf,
  localizeDeep,
  matches,
  parseVersion,
  type RuleFacts,
  versionAtLeast,
  visibleSections,
} from '../../src/features/home/home.rules.js';
import {
  HomeCategoriesService,
  initialsOf,
  toCategoriesView,
} from '../../src/features/home/home.categories.js';
import {
  HomeService,
  decorateCard,
  phoneFor,
  toSnapshot,
} from '../../src/features/home/home.service.js';
import type { LayoutTree, SectionInput, Snapshot } from '../../src/features/home/home.types.js';
import { replaceSchema } from '../../src/features/home/home.validation.js';

const facts = (extra: Partial<RuleFacts> = {}): RuleFacts => ({
  platform: 'android',
  userType: 'farmer',
  region: 'WG',
  farmTypes: ['LAYER'],
  appVersion: [1, 4, 0],
  seed: 'device-1234',
  now: Date.parse('2026-11-24T10:00:00Z'),
  ...extra,
});

const section = (extra: Partial<SectionInput> = {}): SectionInput => ({
  sectionKey: 'featured',
  widgetType: 'PRODUCT_GRID_2X2',
  dataSource: 'DYNAMIC_QUERY',
  feedKey: null,
  eyebrow: null,
  title: { en: 'Featured Product' },
  subtitle: null,
  viewAllLink: null,
  isEnabled: true,
  itemLimit: 4,
  minItems: 1,
  inline: false,
  experimentKey: null,
  config: { query: { isFeatured: true } },
  targeting: null,
  items: [],
  ...extra,
});

const HOSTS = { links: ['farmx.in'], images: ['cdn.farmx.in'] };

describe('home rules', () => {
  it('no targeting always matches; each restriction filters', () => {
    expect(matches(compileRule(null), facts())).toBe(true);
    expect(matches(compileRule({ platforms: ['ios'] }), facts())).toBe(false);
    expect(matches(compileRule({ platforms: ['android'] }), facts({ platform: null }))).toBe(false);
    expect(matches(compileRule({ userTypes: ['guest'] }), facts())).toBe(false);
    expect(matches(compileRule({ regions: ['WG'] }), facts())).toBe(true);
    expect(matches(compileRule({ regions: ['WG'] }), facts({ region: null }))).toBe(false);
    expect(matches(compileRule({ excludeRegions: ['WG'] }), facts())).toBe(false);
    expect(matches(compileRule({ farmTypes: ['BROILER'] }), facts())).toBe(false);
    expect(matches(compileRule({ farmTypes: ['BROILER', 'LAYER'] }), facts())).toBe(true);
  });

  it('time window [activeFrom, activeUntil) and minAppVersion', () => {
    const rule = compileRule({
      activeFrom: '2026-11-24T09:00:00Z',
      activeUntil: '2026-11-24T10:00:00Z',
    });
    expect(matches(rule, facts({ now: Date.parse('2026-11-24T09:59:59Z') }))).toBe(true);
    expect(matches(rule, facts({ now: Date.parse('2026-11-24T10:00:00Z') }))).toBe(false);
    expect(matches(rule, facts({ now: Date.parse('2026-11-24T08:00:00Z') }))).toBe(false);
    expect(matches(compileRule({ minAppVersion: '1.5' }), facts())).toBe(false);
    expect(matches(compileRule({ minAppVersion: '1.4.0' }), facts())).toBe(true);
    expect(matches(compileRule({ minAppVersion: '1.0' }), facts({ appVersion: null }))).toBe(false);
    expect(versionAtLeast(parseVersion('2'), parseVersion('1.9.9'))).toBe(true);
  });

  it('Future facts (flock stage, new user, active order, segments) never match yet', () => {
    expect(matches(compileRule({ flockStages: ['GROWER'] }), facts())).toBe(false);
    expect(matches(compileRule({ isNewUser: true }), facts())).toBe(false);
    expect(matches(compileRule({ hasActiveOrder: false }), facts())).toBe(false);
    expect(matches(compileRule({ segments: ['vip'] }), facts())).toBe(false);
  });

  it('rollout bucket is stable per seed and splits A/B ranges exactly', () => {
    const b = bucketOf('device-1234', 'exp1');
    expect(bucketOf('device-1234', 'exp1')).toBe(b);
    const a = compileRule({ rollout: { percent: 50, salt: 'exp1', offset: 0 } });
    const bb = compileRule({ rollout: { percent: 50, salt: 'exp1', offset: 50 } });
    // Exactly one of the two complementary variants matches for any seed.
    for (const seed of ['d-00000001', 'd-00000002', 'd-00000003', 'd-00000004'])
      expect(Number(matches(a, facts({ seed }))) + Number(matches(bb, facts({ seed })))).toBe(1);
    expect(matches(a, facts({ seed: null }))).toBe(false);
  });

  it('widgets newer than the app’s SDUI version are dropped', () => {
    const tree = {
      id: 'l',
      page: 'HOME',
      layoutNo: 1,
      publishRev: 1,
      settings: {},
      sections: [{ ...section(), id: 's1', displayOrder: 10, items: [] }],
    } as unknown as LayoutTree;
    const compiled = compileSnapshot(toSnapshot(tree, null));
    expect(visibleSections(compiled, facts(), 1)).toHaveLength(1);
    expect(visibleSections(compiled, facts(), 0)).toHaveLength(0);
    expect(sduiOf(undefined)).toBe(1);
    expect(sduiOf('abc')).toBe(1);
    expect(sduiOf('3')).toBe(3);
  });

  it('localizes nested config text and reads Accept-Language', () => {
    const config = {
      cta: { label: { en: 'Consult a vet', hi: 'पशु चिकित्सक' }, deepLink: 'farmx://vet' },
    };
    expect(localizeDeep(config, 'hi')).toEqual({
      cta: { label: 'पशु चिकित्सक', deepLink: 'farmx://vet' },
    });
    expect(localizeDeep(config, 'en')).toEqual({
      cta: { label: 'Consult a vet', deepLink: 'farmx://vet' },
    });
    expect(langOf('hi-IN,hi;q=0.9')).toBe('hi');
    expect(langOf('te-IN')).toBe('en');
  });
});

describe('home layout checks', () => {
  it('widget ↔ dataSource ↔ feedKey must fit', () => {
    const bad = checkLayout(
      [
        section({ dataSource: 'STATIC_ITEMS' }),
        section({
          sectionKey: 'order',
          widgetType: 'LIVE_ORDER_STRIP',
          dataSource: 'REMOTE_FEED',
          config: {},
        }),
        section({
          sectionKey: 'news',
          widgetType: 'NEWS_FEED',
          dataSource: 'REMOTE_FEED',
          feedKey: 'ORDER_LIVE',
          config: {},
        }),
      ],
      HOSTS,
    );
    const paths = bad.issues.map((i) => i.path);
    expect(paths).toContain('body.sections.0.dataSource');
    expect(paths).toContain('body.sections.1.feedKey'); // REMOTE_FEED without a key
    expect(paths).toContain('body.sections.2.feedKey'); // wrong key for the widget
  });

  it('unique keys, at most 3 inline, config defaults applied', () => {
    const { issues, sections } = checkLayout(
      [
        section({ inline: true }),
        section({ sectionKey: 'featured', inline: true }),
        section({ sectionKey: 'c', inline: true }),
        section({ sectionKey: 'd', inline: true }),
      ],
      HOSTS,
    );
    expect(issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(['body.sections.1.sectionKey', 'body.sections.3.inline']),
    );
    expect(sections[0]?.config.fallback).toBe('HIDE');
  });

  it('https deep links and images only on allowlisted hosts; farmx:// always ok', () => {
    const { issues } = checkLayout(
      [
        section({
          sectionKey: 'cats',
          widgetType: 'CATEGORY_GRID',
          dataSource: 'STATIC_ITEMS',
          config: {},
          viewAllLink: 'https://evil.example.com/login',
          items: [
            {
              refType: 'CUSTOM',
              refId: null,
              refCode: null,
              label: { en: 'Lab Test' },
              subtitle: null,
              badge: null,
              image: { url: 'https://img.example.com/x.png' },
              deepLink: 'farmx://lab',
              isEnabled: true,
              targeting: null,
            },
          ],
        }),
      ],
      HOSTS,
    );
    expect(issues.map((i) => i.path)).toEqual([
      'body.sections.0.viewAllLink',
      'body.sections.0.items.0.image.url',
    ]);
    expect(hostAllowed('https://shop.farmx.in/x', ['farmx.in'])).toBe(true);
    expect(hostAllowed('https://farmx.in.evil.com/x', ['farmx.in'])).toBe(false);
  });

  it('warns when targeting uses a Future fact', () => {
    const { warnings } = checkLayout([section({ targeting: { flockStages: ['GROWER'] } })], HOSTS);
    expect(warnings[0]?.path).toBe('body.sections.0.targeting.flockStages');
  });

  it('Joi: en is required on localized text; window must be ordered', () => {
    const body = (s: Record<string, unknown>) => ({
      name: 'x',
      sections: [{ ...section(), ...s }],
    });
    expect(replaceSchema.body.validate(body({ title: { hi: 'केवल हिंदी' } })).error).toBeDefined();
    expect(
      replaceSchema.body.validate(
        body({
          targeting: { activeFrom: '2026-11-25T00:00:00Z', activeUntil: '2026-11-24T00:00:00Z' },
        }),
      ).error?.message,
    ).toMatch(/activeUntil must be after activeFrom/);
    expect(replaceSchema.body.validate(body({})).error).toBeUndefined();
  });
});

describe('home product cards', () => {
  const snap = {
    settings: { orderPhones: { default: '+911111111111', byRegion: { WG: '+912222222222' } } },
  } as unknown as Snapshot;

  it('region phone wins over the default; none → no call button', () => {
    expect(phoneFor(snap, 'WG')).toBe('+912222222222');
    expect(phoneFor(snap, 'KR')).toBe('+911111111111');
    expect(phoneFor({ settings: {} } as Snapshot, 'WG')).toBeNull();
  });

  it('Rx products get Upload Rx; tracking id is stable; priceBreak is null (Future)', () => {
    const card = decorateCard(
      {
        id: 'p1',
        name: 'ND LaSota',
        slug: 'nd',
        imageUrl: null,
        available: true,
        isPrescriptionRequired: true,
      },
      { page: 'HOME', layoutNo: 12, sectionKey: 'featured' },
      null,
      null,
    );
    expect(card.actions).toEqual({
      primary: 'UPLOAD_RX',
      uploadRxLink: 'farmx://rx/upload?productId=p1',
      call: null,
    });
    expect(card.tracking.id).toBe('HOME:12:featured:p1');
    expect(card.priceBreak).toBeNull();
  });
});

describe('home categories page', () => {
  const brand = (name: string) => ({ id: `id-${name}`, name, slug: name, logoUrl: null });
  const disease = (slug: string) => ({
    id: `d-${slug}`,
    name: slug,
    slug,
    iconUrl: null,
    productCount: 3,
  });
  const farm = {
    farmId: 'f1',
    farmName: 'Shed farm',
    category: 'POULTRY_FARM',
    productionTypes: ['LAYER'],
    totalBirdCapacity: 18_500,
    territoryCode: 'WG',
    primaryNodeId: null,
  };
  const ctx = (withFarm: boolean) =>
    ({ authState: withFarm ? 'ok' : 'none', region: null, farm: withFarm ? farm : null }) as never;

  it('initials: two words → first letters, one word → first two, junk-safe', () => {
    expect(initialsOf('Godavari Bio')).toBe('GB');
    expect(initialsOf('Deccan AH')).toBe('DA');
    expect(initialsOf('Coastal')).toBe('CO');
    expect(initialsOf('  zoetis-india ltd ')).toBe('ZI');
    expect(initialsOf('')).toBe('');
  });

  it('view: deep links, caps, Future fields null, bird count only with a farm', () => {
    const parts = {
      categories: [
        {
          id: 'c1',
          parentId: null,
          name: 'Feed',
          slug: 'feed',
          imageUrl: 'https://cdn.farmx.in/feed.png',
          depth: 0,
          sortOrder: 1,
          childCount: 2,
        },
      ],
      stages: [{ code: 'PRE_LAYER', label: 'Pre-lay' }],
      problems: Array.from({ length: 15 }, (_, i) => disease(`p${String(i)}`)),
      makers: Array.from({ length: 12 }, (_, i) => brand(`Maker ${String(i)}`)),
    };
    const farmer = toCategoriesView(parts, ctx(true));
    expect(farmer.categories[0]).toEqual({
      id: 'c1',
      name: 'Feed',
      slug: 'feed',
      imageUrl: 'https://cdn.farmx.in/feed.png',
      subtitle: null,
      badge: null,
      deepLink: 'farmx://category/feed',
    });
    expect(farmer.flock).toEqual({
      stages: [
        { code: 'PRE_LAYER', label: 'Pre-lay', deepLink: 'farmx://products?flockStage=PRE_LAYER' },
      ],
      currentStage: null,
      shedLabel: null,
      ageWeeks: null,
      birdCount: 18_500,
      productsForStage: null,
    });
    expect(farmer.problems).toHaveLength(12);
    expect(farmer.problems[0]!.deepLink).toBe('farmx://products?diseaseSlug=p0');
    expect(farmer.makers).toHaveLength(9);
    expect(farmer.makers[0]).toMatchObject({
      initials: 'M0',
      deepLink: 'farmx://products?brandId=id-Maker 0',
    });
    expect(toCategoriesView(parts, ctx(false)).flock.birdCount).toBeNull();
    const empty = toCategoriesView(
      { categories: null, stages: null, problems: null, makers: null },
      ctx(false),
    );
    expect(empty).toMatchObject({ categories: [], problems: [], makers: [] });
    expect(empty.flock.stages).toEqual([]);
  });

  /** Real HomeService.remember over an in-memory cache; upstream calls are spies. */
  const setup = (
    over: Partial<
      Record<'categories' | 'stages' | 'problems' | 'makers', () => Promise<unknown>>
    > = {},
  ) => {
    const store = new Map<string, unknown>();
    const cache = {
      get: (k: string) => Promise.resolve(store.get(k)),
      set: (k: string, v: unknown) => {
        store.set(k, v);
        return Promise.resolve();
      },
      invalidate: () => Promise.resolve(),
    };
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const catalogClient = {
      categories: vi.fn(over.categories ?? (() => Promise.resolve([]))),
      featuredBrands: vi.fn(over.makers ?? (() => Promise.resolve([brand('Godavari Bio')]))),
    };
    const productClient = {
      flockStages: vi.fn(
        over.stages ?? (() => Promise.resolve([{ code: 'GROWER', label: 'Grower' }])),
      ),
      diseases: vi.fn(over.problems ?? (() => Promise.resolve([disease('respiratory')]))),
    };
    const homeService = new HomeService({ cache, logger, catalogClient, productClient } as never);
    const svc = new HomeCategoriesService({ homeService, catalogClient, productClient } as never);
    return { svc, store, catalogClient, productClient };
  };

  it('single-flight: 50 parallel cold calls → one upstream call per part; then served from cache', async () => {
    const { svc, catalogClient, productClient } = setup();
    const pages = await Promise.all(Array.from({ length: 50 }, () => svc.page(ctx(false))));
    expect(pages.every((p) => p.meta.degraded.length === 0)).toBe(true);
    expect(pages[49]!.view.makers[0]!.initials).toBe('GB');
    expect(catalogClient.categories).toHaveBeenCalledTimes(1);
    expect(catalogClient.featuredBrands).toHaveBeenCalledWith(9, 300);
    expect(productClient.diseases).toHaveBeenCalledWith(300, true);
    expect(productClient.flockStages).toHaveBeenCalledTimes(1);
    await svc.page(ctx(true));
    expect(productClient.diseases).toHaveBeenCalledTimes(1);
  });

  it('upstream down → stale copy (meta.stale); no stale copy → empty part (meta.degraded)', async () => {
    const down = () => Promise.reject(new Error('down'));
    const { svc, store } = setup({ problems: down, makers: down });
    store.set(userKeys.homeCatalog('diseases', 'non-empty', true), { v: [disease('heat-stress')] });
    const { view, meta } = await svc.page(ctx(false));
    expect(view.problems.map((p) => p.slug)).toEqual(['heat-stress']);
    expect(meta.stale).toEqual(['problems']);
    expect(meta.degraded).toEqual(['makers']);
    expect(view.makers).toEqual([]);
    expect(view.flock.stages).toHaveLength(1);
  });

  it('a part slower than the 350 ms budget is left empty; the page still answers', async () => {
    vi.useFakeTimers();
    try {
      const { svc } = setup({ categories: () => new Promise(() => undefined) });
      const pending = svc.page(ctx(false));
      await vi.advanceTimersByTimeAsync(351);
      const { view, meta } = await pending;
      expect(meta.degraded).toEqual(['categories']);
      expect(view.categories).toEqual([]);
      expect(view.problems).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
