import type { Paginated } from '@farmx/common/types';
import { type Tx, advisoryXactLock, cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type {
  AdminListQuery,
  HomePage,
  ItemRow,
  LayoutRow,
  LayoutStatus,
  LayoutSummary,
  LayoutTree,
  PageSettings,
  SectionInput,
  SectionRow,
} from './home.types.js';

const LAYOUT = {
  id: true,
  page: true,
  layoutNo: true,
  name: true,
  status: true,
  notes: true,
  settings: true,
  scheduledPublishAt: true,
  publishedAt: true,
  publishedByUserId: true,
  publishRev: true,
  version: true,
  createdByUserId: true,
  updatedByUserId: true,
  createdAt: true,
  updatedAt: true,
} as const;

const SECTIONS = {
  orderBy: [{ displayOrder: 'asc' }, { sectionKey: 'asc' }],
  include: { items: { orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }] } },
} satisfies Prisma.HomeSectionFindManyArgs;

/** Layout columns a status change / save may set (settings typed, converted to JSON here). */
export type LayoutPatch = Omit<Prisma.HomeConfigurationUpdateManyMutationInput, 'settings'> & {
  settings?: PageSettings;
};

const json = (value: unknown) => value as Prisma.InputJsonValue;
/** Nullable JSON column: null → SQL NULL. */
const nullableJson = (value: unknown) =>
  value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);

type LayoutRecord = Prisma.HomeConfigurationGetPayload<{ select: typeof LAYOUT }>;
type SectionRecord = Prisma.HomeSectionGetPayload<{ include: { items: true } }>;

const toLayout = (r: LayoutRecord): LayoutRow => ({ ...r, settings: r.settings as PageSettings });

const toSection = (s: SectionRecord): SectionRow => ({
  id: s.id,
  sectionKey: s.sectionKey,
  widgetType: s.widgetType,
  dataSource: s.dataSource,
  feedKey: s.feedKey,
  eyebrow: s.eyebrow as SectionRow['eyebrow'],
  title: s.title as SectionRow['title'],
  subtitle: s.subtitle as SectionRow['subtitle'],
  viewAllLink: s.viewAllLink,
  displayOrder: s.displayOrder,
  isEnabled: s.isEnabled,
  itemLimit: s.itemLimit,
  minItems: s.minItems,
  inline: s.inline,
  experimentKey: s.experimentKey,
  config: s.config as Record<string, unknown>,
  targeting: s.targeting as SectionRow['targeting'],
  items: s.items.map((i): ItemRow => ({
    id: i.id,
    refType: i.refType,
    refId: i.refId,
    refCode: i.refCode,
    label: i.label as unknown as ItemRow['label'],
    subtitle: i.subtitle as ItemRow['subtitle'],
    badge: i.badge as ItemRow['badge'],
    image: i.image as ItemRow['image'],
    deepLink: i.deepLink,
    displayOrder: i.displayOrder,
    isEnabled: i.isEnabled,
    targeting: i.targeting as ItemRow['targeting'],
    refBroken: i.refBroken,
  })),
});

/** Only place that queries `home_configurations`, `home_sections`, `home_section_items`. */
export class HomeRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** Serialises layout writes of one page (numbering, publish, schedule). */
  lockPage(tx: Tx, page: HomePage): Promise<void> {
    return advisoryXactLock(tx, `user:home:${page}`);
  }

  async nextLayoutNo(tx: Tx, page: HomePage): Promise<number> {
    const { _max } = await tx.homeConfiguration.aggregate({
      where: { page },
      _max: { layoutNo: true },
    });
    return (_max.layoutNo ?? 0) + 1;
  }

  async nextPublishRev(tx: Tx, page: HomePage): Promise<number> {
    const { _max } = await tx.homeConfiguration.aggregate({
      where: { page },
      _max: { publishRev: true },
    });
    return (_max.publishRev ?? 0) + 1;
  }

  async create(
    tx: Tx,
    data: {
      page: HomePage;
      layoutNo: number;
      name: string;
      notes: string | null;
      settings: PageSettings;
      userId: string;
    },
  ): Promise<LayoutRow> {
    const row = await tx.homeConfiguration.create({
      data: {
        page: data.page,
        layoutNo: data.layoutNo,
        name: data.name,
        notes: data.notes,
        settings: json(data.settings),
        createdByUserId: data.userId,
        updatedByUserId: data.userId,
      },
      select: LAYOUT,
    });
    return toLayout(row);
  }

  async findRow(id: string, tx?: Tx): Promise<LayoutRow | null> {
    const client = tx ?? this.db;
    const row = await withPrismaErrors(() =>
      client.homeConfiguration.findUnique({ where: { id }, select: LAYOUT }),
    );
    return row === null ? null : toLayout(row);
  }

  async tree(id: string, tx?: Tx): Promise<LayoutTree | null> {
    const client = tx ?? this.db;
    const row = await withPrismaErrors(() =>
      client.homeConfiguration.findUnique({
        where: { id },
        select: { ...LAYOUT, sections: SECTIONS },
      }),
    );
    if (row === null) return null;
    const { sections, ...layout } = row;
    return { ...toLayout(layout), sections: sections.map(toSection) };
  }

  /** The live layout of a page (sections + items), or null. */
  async live(page: HomePage): Promise<LayoutTree | null> {
    const row = await withPrismaErrors(() =>
      this.db.homeConfiguration.findFirst({
        where: { page, status: 'PUBLISHED' },
        select: { ...LAYOUT, sections: SECTIONS },
      }),
    );
    if (row === null) return null;
    const { sections, ...layout } = row;
    return { ...toLayout(layout), sections: sections.map(toSection) };
  }

  async scheduled(page: HomePage, tx?: Tx): Promise<LayoutRow | null> {
    const client = tx ?? this.db;
    const row = await withPrismaErrors(() =>
      client.homeConfiguration.findFirst({ where: { page, status: 'SCHEDULED' }, select: LAYOUT }),
    );
    return row === null ? null : toLayout(row);
  }

  async published(tx: Tx, page: HomePage): Promise<LayoutRow | null> {
    const row = await tx.homeConfiguration.findFirst({
      where: { page, status: 'PUBLISHED' },
      select: LAYOUT,
    });
    return row === null ? null : toLayout(row);
  }

  async list(query: AdminListQuery): Promise<Paginated<LayoutSummary>> {
    const rows = await withPrismaErrors(() =>
      this.db.homeConfiguration.findMany({
        where: {
          ...(query.page && { page: query.page }),
          ...(query.status && { status: query.status }),
        },
        orderBy: { id: 'desc' },
        select: { ...LAYOUT, _count: { select: { sections: true } } },
        ...cursorArgs(query),
      }),
    );
    const page = toPage(rows, query.limit);
    return {
      ...page,
      items: page.items.map(({ _count, ...r }) => ({
        ...toLayout(r),
        sectionCount: _count.sections,
      })),
    };
  }

  /**
   * Conditional update (optimistic concurrency): applies only while `version` (and, when given,
   * `status`) still match; bumps the version. false = someone else won.
   */
  async update(
    tx: Tx,
    id: string,
    guard: { version?: number; status?: LayoutStatus },
    patch: LayoutPatch,
  ): Promise<boolean> {
    const { settings, ...data } = patch;
    const { count } = await tx.homeConfiguration.updateMany({
      where: {
        id,
        ...(guard.version !== undefined && { version: guard.version }),
        ...(guard.status !== undefined && { status: guard.status }),
      },
      data: {
        ...data,
        ...(settings !== undefined && { settings: json(settings) }),
        version: { increment: 1 },
      },
    });
    return count === 1;
  }

  /** Replaces every section + item of a layout (drafts only; caller holds the version guard). */
  async replaceSections(tx: Tx, configurationId: string, sections: SectionInput[]): Promise<void> {
    await tx.homeSection.deleteMany({ where: { configurationId } });
    for (const [index, s] of sections.entries()) {
      await tx.homeSection.create({
        data: {
          configurationId,
          sectionKey: s.sectionKey,
          widgetType: s.widgetType,
          dataSource: s.dataSource,
          feedKey: s.feedKey,
          eyebrow: nullableJson(s.eyebrow),
          title: nullableJson(s.title),
          subtitle: nullableJson(s.subtitle),
          viewAllLink: s.viewAllLink,
          displayOrder: s.displayOrder ?? (index + 1) * 10,
          isEnabled: s.isEnabled,
          itemLimit: s.itemLimit,
          minItems: s.minItems,
          inline: s.inline,
          experimentKey: s.experimentKey,
          config: json(s.config),
          targeting: nullableJson(s.targeting),
          items: {
            createMany: {
              data: s.items.map((i, j) => ({
                refType: i.refType,
                refId: i.refId,
                refCode: i.refCode,
                label: json(i.label),
                subtitle: nullableJson(i.subtitle),
                badge: nullableJson(i.badge),
                image: nullableJson(i.image),
                deepLink: i.deepLink,
                displayOrder: i.displayOrder ?? (j + 1) * 10,
                isEnabled: i.isEnabled,
                targeting: nullableJson(i.targeting),
              })),
            },
          },
        },
      });
    }
  }

  async setDisplayOrder(tx: Tx, configurationId: string, keys: readonly string[]): Promise<void> {
    for (const [index, sectionKey] of keys.entries())
      await tx.homeSection.updateMany({
        where: { configurationId, sectionKey },
        data: { displayOrder: (index + 1) * 10 },
      });
  }

  /** Sets `refBroken` on exactly the given items of a layout (all others cleared). */
  async markBroken(
    tx: Tx,
    configurationId: string,
    brokenItemIds: readonly string[],
  ): Promise<void> {
    await tx.homeSectionItem.updateMany({
      where: { section: { configurationId } },
      data: { refBroken: false },
    });
    if (brokenItemIds.length > 0)
      await tx.homeSectionItem.updateMany({
        where: { id: { in: [...brokenItemIds] }, section: { configurationId } },
        data: { refBroken: true },
      });
  }
}
