/**
 * Seeds the default HOME and All Categories layouts (as in the Figma) as **DRAFTs**. An admin
 * reviews them and publishes (`POST /v1/admin/home/layouts/:id/publish`), which runs the ref check.
 *
 *   pnpm --filter @farmx/user-service home:seed
 *
 * Idempotent: a page that already has any layout is skipped. No product / category / brand ids
 * are hard-coded: categories come live from the catalog (CATALOG_CATEGORIES), rails use saved
 * queries, flock stages use the seeded FLOCK_STAGE codes. Before publishing, create the banner
 * placement `HOME_TOP` (catalog banners) and pick brands for "Verified makers".
 *
 * Env: DATABASE_URL (required); HOME_LINK_HOSTS / HOME_IMAGE_HOSTS (optional).
 */
import { createLogger } from '@farmx/common/logger';
import { createTransactionRunner } from '@farmx/database';
import { closeDatabase, getDatabase } from '@farmx/database/client';

import { checkLayout, hostsOf } from '../src/features/home/home.admin.service.js';
import { HomeRepository } from '../src/features/home/home.repository.js';
import type {
  HomePage,
  ItemInput,
  ReplaceLayoutInput,
  SectionInput,
} from '../src/features/home/home.types.js';
import { replaceSchema } from '../src/features/home/home.validation.js';

const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const print = (text: string) => process.stdout.write(`${text}\n`);

type Raw = Partial<SectionInput> & Pick<SectionInput, 'sectionKey' | 'widgetType' | 'dataSource'>;
const stage = (code: string, label: string, subtitle?: string): Partial<ItemInput> => ({
  refType: 'FLOCK_STAGE',
  refCode: code,
  label: { en: label },
  ...(subtitle !== undefined && { badge: { en: subtitle } }),
  deepLink: `farmx://products?flockStage=${code}`,
});
const problem = (slug: string, label: string): Partial<ItemInput> => ({
  refType: 'CUSTOM',
  label: { en: label },
  deepLink: `farmx://products?diseaseSlug=${slug}`,
});

const HOME: Raw[] = [
  {
    sectionKey: 'hero',
    widgetType: 'BANNER_CAROUSEL',
    dataSource: 'BANNER_PLACEMENT',
    itemLimit: 5,
    config: { placementCode: 'HOME_TOP', autoplayMs: 4000 },
  },
  {
    sectionKey: 'categories',
    widgetType: 'CATEGORY_GRID',
    dataSource: 'CATALOG_CATEGORIES',
    title: { en: 'Categories', hi: 'श्रेणियाँ' },
    viewAllLink: 'farmx://categories',
    itemLimit: 8,
    config: { style: 'GRID_4' },
  },
  {
    sectionKey: 'live-order',
    widgetType: 'LIVE_ORDER_STRIP',
    dataSource: 'REMOTE_FEED',
    feedKey: 'ORDER_LIVE',
  },
  {
    sectionKey: 'top-picks',
    widgetType: 'PRODUCT_GRID_2X2',
    dataSource: 'DYNAMIC_QUERY',
    itemLimit: 4,
    inline: true,
    config: { query: { sort: 'rating', inStock: true } },
  },
  {
    sectionKey: 'vet-consult',
    widgetType: 'VET_CONSULT_PROMO',
    dataSource: 'STATIC_ITEMS',
    feedKey: 'VET_AVAILABILITY',
    minItems: 0,
    title: { en: 'Not sure what your flock needs?' },
    subtitle: { en: 'Speak to a verified poultry veterinarian in Hindi or English.' },
    config: {
      badge: { en: 'FARMSTEP VET' },
      priceChip: { en: 'from ₹199' },
      cta: { label: { en: 'Consult a vet' }, deepLink: 'farmx://vet' },
    },
  },
  {
    sectionKey: 'featured',
    widgetType: 'PRODUCT_HORIZONTAL_RAIL',
    dataSource: 'DYNAMIC_QUERY',
    title: { en: 'Featured Product' },
    viewAllLink: 'farmx://products?isFeatured=true',
    itemLimit: 6,
    inline: true,
    config: { query: { isFeatured: true } },
  },
  {
    sectionKey: 'clearance',
    widgetType: 'PRODUCT_HORIZONTAL_RAIL',
    dataSource: 'LIVE_OFFERS',
    title: { en: 'Clearance & Deals' },
    viewAllLink: 'farmx://products?sort=discount',
    itemLimit: 6,
    inline: true,
  },
  {
    sectionKey: 'requirement-calendar',
    widgetType: 'REQUIREMENT_CALENDAR',
    dataSource: 'REMOTE_FEED',
    feedKey: 'REQUIREMENT_DUE',
    title: { en: 'Requirement calendar' },
  },
  {
    sectionKey: 'appointment',
    widgetType: 'APPOINTMENT_CARD',
    dataSource: 'REMOTE_FEED',
    feedKey: 'APPOINTMENT_NEXT',
  },
  {
    sectionKey: 'bulk-feed',
    widgetType: 'BULK_FEED_PROMO',
    dataSource: 'STATIC_ITEMS',
    minItems: 0,
    eyebrow: { en: 'BULK ORDERS' },
    title: { en: 'Planning tonnes of feed?' },
    subtitle: {
      en: 'Get transparent delivered pricing from verified mills and suppliers — no bargaining, no hidden charges.',
    },
    config: {
      note: { en: 'Average response: 18 minutes' },
      cta: { label: { en: 'Request a bulk quote' }, deepLink: 'farmx://bulk-quote' },
    },
  },
  {
    sectionKey: 'flock-stage',
    widgetType: 'FLOCK_STAGE_SELECTOR',
    dataSource: 'STATIC_ITEMS',
    eyebrow: { en: 'SHOP SMARTER' },
    title: { en: 'What stage is your flock in?' },
    config: { style: 'CARDS' },
    items: [
      stage('CHICK', 'Day-old chicks', '0-7 days'),
      stage('BROODER', 'Brooding', '8-21 days'),
      stage('GROWER', 'Grower', '4-8 weeks'),
      stage('LAYER', 'Layer / breeder', '10+ weeks'),
    ] as ItemInput[],
  },
  {
    sectionKey: 'news',
    widgetType: 'NEWS_FEED',
    dataSource: 'REMOTE_FEED',
    feedKey: 'NEWS_LATEST',
    eyebrow: { en: 'FARM KNOWLEDGE' },
    title: { en: 'News & Updates' },
    viewAllLink: 'farmx://news',
    config: { limit: 3 },
  },
  {
    sectionKey: 'buy-again',
    widgetType: 'REORDER_CARD',
    dataSource: 'REMOTE_FEED',
    feedKey: 'BUY_AGAIN',
    title: { en: 'Buy Again' },
  },
];

const CATEGORIES: Raw[] = [
  {
    sectionKey: 'categories',
    widgetType: 'CATEGORY_GRID',
    dataSource: 'CATALOG_CATEGORIES',
    itemLimit: 12,
    config: { style: 'LIST_CARD' },
  },
  {
    sectionKey: 'flock-stage',
    widgetType: 'FLOCK_STAGE_SELECTOR',
    dataSource: 'STATIC_ITEMS',
    feedKey: 'FLOCK_CONTEXT',
    title: { en: 'Your flock stage' },
    config: { style: 'CHIPS' },
    items: [
      stage('BROODER', 'Brooding'),
      stage('GROWER', 'Grower'),
      stage('PRE_LAYER', 'Pre-lay'),
      stage('LAYER', 'Peak-lay'),
      stage('LAYER', 'Late-lay'),
    ] as ItemInput[],
  },
  {
    sectionKey: 'shop-by-problem',
    widgetType: 'SHOP_BY_PROBLEM',
    dataSource: 'STATIC_ITEMS',
    title: { en: 'Shop by problem' },
    viewAllLink: 'farmx://problems',
    itemLimit: 12,
    config: { columns: 2 },
    items: [
      problem('respiratory', 'Respiratory'),
      problem('heat-stress', 'Heat stress'),
      problem('gut-cocci', 'Gut & cocci'),
      problem('mycotoxins', 'Mycotoxins'),
      problem('shell-quality', 'Shell quality'),
      problem('water-litter', 'Water & litter'),
    ] as ItemInput[],
  },
  {
    sectionKey: 'makers',
    widgetType: 'BRAND_GRID',
    dataSource: 'STATIC_ITEMS',
    title: { en: 'Verified makers' },
    viewAllLink: 'farmx://brands',
    itemLimit: 9,
    config: { columns: 3, style: 'CIRCLES' },
  },
];

const DEFAULTS: Record<HomePage, Raw[]> = { HOME, CATEGORIES };

/** Joi defaults + the same widget / host rules as the admin PUT. */
function prepare(page: HomePage): SectionInput[] {
  const body = { name: `Default ${page}`, sections: DEFAULTS[page] };
  const result = replaceSchema.body.validate(body, { abortEarly: false });
  if (result.error !== undefined) throw new Error(`${page}: ${result.error.message}`);
  const input = result.value as ReplaceLayoutInput;
  const { issues, sections } = checkLayout(input.sections, {
    links: hostsOf(process.env.HOME_LINK_HOSTS ?? 'farmx.in'),
    images: hostsOf(process.env.HOME_IMAGE_HOSTS ?? 'cdn.farmx.in,digitaloceanspaces.com'),
  });
  if (issues.length > 0) throw new Error(`${page}: ${JSON.stringify(issues)}`);
  return sections;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') throw new Error('DATABASE_URL is required');
  const db = getDatabase({
    url,
    logger: createLogger({ service: 'home-seed', level: 'warn' }),
    poolSize: 2,
  });
  const repo = new HomeRepository({ db });
  const run = createTransactionRunner(db);

  for (const page of ['HOME', 'CATEGORIES'] as const) {
    if ((await db.homeConfiguration.count({ where: { page } })) > 0) {
      print(`${page}: already has layouts, skipped`);
      continue;
    }
    const sections = prepare(page);
    const id = await run(async (tx) => {
      const row = await repo.create(tx, {
        page,
        layoutNo: await repo.nextLayoutNo(tx, page),
        name: page === 'HOME' ? 'Default home (Figma)' : 'Default all categories (Figma)',
        notes: 'Seeded draft. Review, add banners / brands, then publish.',
        settings: {},
        userId: SYSTEM_ACTOR_ID,
      });
      await repo.replaceSections(tx, row.id, sections);
      await tx.userAuditLog.create({
        data: {
          actorUserId: SYSTEM_ACTOR_ID,
          action: 'home_layout.create',
          targetType: 'home_layout',
          targetId: row.id,
          after: { page, seeded: true, sections: sections.length },
        },
      });
      return row.id;
    });
    print(`${page}: draft ${id} created (${String(sections.length)} sections)`);
  }
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
