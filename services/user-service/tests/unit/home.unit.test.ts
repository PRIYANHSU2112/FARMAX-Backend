import { describe, expect, it } from 'vitest';

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
import { decorateCard, phoneFor, toSnapshot } from '../../src/features/home/home.service.js';
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
