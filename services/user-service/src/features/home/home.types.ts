import type { CursorQuery } from '@farmx/common/types';

import type { ProductCard } from '../../adapters/product-client.js';

// ── Enums (mirror home.prisma) ──

export const PAGES = ['HOME', 'CATEGORIES'] as const;
export type HomePage = (typeof PAGES)[number];

export const LAYOUT_STATUSES = ['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED'] as const;
export type LayoutStatus = (typeof LAYOUT_STATUSES)[number];

export const WIDGETS = [
  'BANNER_CAROUSEL',
  'CATEGORY_GRID',
  'PRODUCT_GRID_2X2',
  'PRODUCT_HORIZONTAL_RAIL',
  'VET_CONSULT_PROMO',
  'REORDER_CARD',
  'FLOCK_STAGE_SELECTOR',
  'NEWS_FEED',
  'BULK_FEED_PROMO',
  'LIVE_ORDER_STRIP',
  'REQUIREMENT_CALENDAR',
  'APPOINTMENT_CARD',
  'SHOP_BY_PROBLEM',
  'BRAND_GRID',
] as const;
export type WidgetType = (typeof WIDGETS)[number];

export const DATA_SOURCES = [
  'STATIC_ITEMS',
  'MANUAL_PRODUCTS',
  'DYNAMIC_QUERY',
  'LIVE_OFFERS',
  'BANNER_PLACEMENT',
  'CATALOG_CATEGORIES',
  'REMOTE_FEED',
] as const;
export type DataSource = (typeof DATA_SOURCES)[number];

/** Sources whose data is product cards (served by `/home/sections`). */
export const PRODUCT_SOURCES: readonly DataSource[] = [
  'MANUAL_PRODUCTS',
  'DYNAMIC_QUERY',
  'LIVE_OFFERS',
];

export const FEED_KEYS = [
  'ORDER_LIVE',
  'APPOINTMENT_NEXT',
  'NEWS_LATEST',
  'BUY_AGAIN',
  'VET_AVAILABILITY',
  'FLOCK_CONTEXT',
  'REQUIREMENT_DUE',
] as const;
export type FeedKey = (typeof FEED_KEYS)[number];

export const REF_TYPES = [
  'CATEGORY',
  'FLOCK_STAGE',
  'DISEASE',
  'BRAND',
  'PRODUCT',
  'CUSTOM',
] as const;
export type RefType = (typeof REF_TYPES)[number];

export const PLATFORMS = ['android', 'ios', 'web'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const USER_TYPES = ['guest', 'farmer'] as const;
export type HomeUserType = (typeof USER_TYPES)[number];

export const LANGS = ['en', 'hi'] as const;
export type Lang = (typeof LANGS)[number];

/** Response contract version (`schemaVersion`); bump on a breaking change of the JSON shape. */
export const SCHEMA_VERSION = 1;

// ── Stored JSON shapes ──

/** Translatable text. `en` is always present; other languages fall back to it. */
export interface Localized {
  en: string;
  hi?: string;
}

export interface ImageRef {
  mediaId?: string;
  url: string;
  width?: number;
  height?: number;
}

/** Who sees a section or item. A missing field = no restriction. */
export interface Targeting {
  platforms?: Platform[];
  userTypes?: HomeUserType[];
  regions?: string[];
  excludeRegions?: string[];
  farmTypes?: string[];
  /** ⏳ Future: no flock model yet; a rule on it never matches. */
  flockStages?: string[];
  /** ⏳ Future. */
  isNewUser?: boolean;
  /** ⏳ Future. */
  hasActiveOrder?: boolean;
  /** ⏳ Future. */
  segments?: string[];
  /** ISO date-times. */
  activeFrom?: string;
  activeUntil?: string;
  minAppVersion?: string;
  /** Bucket range [offset, offset + percent) of hash(deviceId + salt) % 100. */
  rollout?: { percent: number; salt: string; offset?: number };
}

export interface PageSettings {
  orderPhones?: { default?: string; byRegion?: Record<string, string> };
}

// ── Rows (repository ↔ service) ──

export interface ItemRow {
  id: string;
  refType: RefType;
  refId: string | null;
  refCode: string | null;
  label: Localized;
  subtitle: Localized | null;
  badge: Localized | null;
  image: ImageRef | null;
  deepLink: string;
  displayOrder: number;
  isEnabled: boolean;
  targeting: Targeting | null;
  refBroken: boolean;
}

export interface SectionRow {
  id: string;
  sectionKey: string;
  widgetType: WidgetType;
  dataSource: DataSource;
  feedKey: FeedKey | null;
  eyebrow: Localized | null;
  title: Localized | null;
  subtitle: Localized | null;
  viewAllLink: string | null;
  displayOrder: number;
  isEnabled: boolean;
  itemLimit: number;
  minItems: number;
  inline: boolean;
  experimentKey: string | null;
  config: Record<string, unknown>;
  targeting: Targeting | null;
  items: ItemRow[];
}

export interface LayoutRow {
  id: string;
  page: HomePage;
  layoutNo: number;
  name: string;
  status: LayoutStatus;
  notes: string | null;
  settings: PageSettings;
  scheduledPublishAt: Date | null;
  publishedAt: Date | null;
  publishedByUserId: string | null;
  publishRev: number | null;
  version: number;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface LayoutTree extends LayoutRow {
  sections: SectionRow[];
}

export interface LayoutSummary extends LayoutRow {
  sectionCount: number;
}

// ── Admin input ──

export type ItemInput = Omit<ItemRow, 'id' | 'refBroken' | 'displayOrder'> & {
  displayOrder?: number;
};
export type SectionInput = Omit<SectionRow, 'id' | 'items' | 'displayOrder'> & {
  displayOrder?: number;
  items: ItemInput[];
};

export interface CreateLayoutInput {
  page: HomePage;
  name: string;
  notes?: string;
  cloneFromId?: string;
}

export interface ReplaceLayoutInput {
  name: string;
  notes?: string | null;
  settings?: PageSettings;
  sections: SectionInput[];
}

export interface ReorderInput {
  keys: string[];
}

export interface PublishInput {
  reason: string;
  scheduledPublishAt?: Date;
}

export interface ReasonInput {
  reason: string;
}

export interface AdminListQuery extends CursorQuery {
  page?: HomePage;
  status?: LayoutStatus;
  limit: number;
}

export interface PreviewQuery {
  platform?: Platform;
  region?: string;
  userType?: HomeUserType;
  farmType?: string[];
  sdui?: number;
  appVersion?: string;
  lang?: Lang;
  at?: Date;
  deviceId?: string;
}

// ── Snapshot (JSON-safe: survives Redis) ──

export interface Snapshot {
  layoutId: string;
  page: HomePage;
  layoutNo: number;
  publishRev: number;
  settings: PageSettings;
  sections: SectionRow[];
  /** epoch ms of the next SCHEDULED layout's go-live, or null. */
  nextScheduledAt: number | null;
}

// ── Request context ──

export interface HomeContext {
  platform: Platform | null;
  appVersion: string | null;
  sdui: number;
  lang: Lang;
  userType: HomeUserType;
  userId: string | null;
  deviceId: string | null;
  authState: 'none' | 'ok' | 'expired' | 'unavailable';
  /** Server-side only (farm territory); never from a header. */
  region: string | null;
  /** Depot serving the farm (stock filter); server-side only. */
  nodeId: string | null;
  farmTypes: string[];
  farm: FarmFacts | null;
  /** Caller's bearer token, forwarded to feeds. Never logged or cached. */
  bearer: string | null;
  now: number;
}

export interface FarmFacts {
  farmId: string;
  farmName: string;
  category: string;
  productionTypes: string[];
  totalBirdCapacity: number | null;
  territoryCode: string | null;
  primaryNodeId: string | null;
}

// ── Public views ──

export interface Tracking {
  id: string;
  experimentKey?: string;
  bucket?: number;
}

export interface ItemView {
  id: string;
  refType: RefType;
  refId: string | null;
  refCode: string | null;
  label: string;
  subtitle: string | null;
  badge: string | null;
  image: ImageView | null;
  deepLink: string;
  tracking: Tracking;
}

/** `variants` / `blurHash`: ⏳ Future (media-service does not produce them yet). */
export interface ImageView extends ImageRef {
  aspectRatio: number | null;
  variants: null;
  blurHash: null;
}

export interface CardActions {
  primary: 'ADD_TO_CART' | 'UPLOAD_RX';
  uploadRxLink: string | null;
  call: { type: 'PHONE_ORDER'; tel: string } | null;
}

/** product-service ProductCard (unchanged) + home extras. */
export type HomeProductCard = ProductCard & {
  tracking: Tracking;
  actions: CardActions;
  /** "₹306 at 50+". ⏳ Future: null until product-service adds it to the card. */
  priceBreak: unknown;
  /** true/false only when the list was filtered at the caller's depot; null = unknown. */
  inStockAtDepot: boolean | null;
};

export interface ProductPage {
  items: HomeProductCard[];
  nextCursor: string | null;
}

export interface SectionView {
  key: string;
  widget: WidgetType;
  dataSource: DataSource;
  order: number;
  eyebrow: string | null;
  title: string | null;
  subtitle: string | null;
  viewAllLink: string | null;
  minItems: number;
  config: Record<string, unknown>;
  tracking: Tracking;
  items?: ItemView[];
  banners?: unknown[];
  aspectRatio?: string | null;
  fetch?: { endpoint: string; limit: number };
  data?: ProductPage;
  feed?: { key: FeedKey; endpoint: string; requiresLogin: boolean; available: boolean };
}

export interface LayoutView {
  schemaVersion: number;
  page: HomePage;
  layoutNo: number | null;
  publishRev: number | null;
  sections: SectionView[];
}

export interface HomeMeta {
  authState: HomeContext['authState'];
  region: string | null;
  degraded: string[];
  stale: string[];
  ttlSeconds: number;
  timings?: Record<string, number>;
}

export type FeedStatus = 'OK' | 'EMPTY' | 'AUTH_REQUIRED' | 'UNAVAILABLE' | 'NOT_AVAILABLE';

export interface FeedResult {
  key: FeedKey;
  status: FeedStatus;
  data: unknown;
}

// ── Categories page (`GET /home/categories`, fixed shape) ──

/** The page's parts; a failed part is `[]` and its name lands in `meta.degraded`. */
export const CATEGORY_PAGE_PARTS = ['categories', 'stages', 'problems', 'makers'] as const;
export type CategoryPagePart = (typeof CATEGORY_PAGE_PARTS)[number];

export interface CategoryCardView {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  /** ⏳ Future: catalog's public tree has no description yet. */
  subtitle: string | null;
  /** ⏳ Future: e.g. "Coming Soon" (no catalog flag yet). */
  badge: string | null;
  deepLink: string;
}

export interface FlockStageChipView {
  code: string;
  label: string;
  deepLink: string;
}

export interface FlockView {
  stages: FlockStageChipView[];
  /** ⏳ Future: farm-service has no flock batches (stage / shed / age) yet. */
  currentStage: string | null;
  shedLabel: string | null;
  ageWeeks: number | null;
  /** The farm's bird capacity; null for guests or when not set. */
  birdCount: number | null;
  /** ⏳ Future: needs `currentStage`. */
  productsForStage: number | null;
}

export interface ProblemCardView {
  id: string;
  name: string;
  slug: string;
  iconUrl: string | null;
  productCount: number;
  deepLink: string;
}

export interface MakerView {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  /** Fallback avatar text when there is no logo ("Godavari Bio" → "GB"). */
  initials: string;
  deepLink: string;
}

export interface CategoriesPageView {
  categories: CategoryCardView[];
  flock: FlockView;
  problems: ProblemCardView[];
  makers: MakerView[];
}
