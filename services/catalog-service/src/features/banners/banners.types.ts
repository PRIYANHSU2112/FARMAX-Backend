/** Click actions a banner can carry. Extend here (and in Joi) — no migration needed. */
export const ACTION_TYPES = [
  'NONE',
  'PRODUCT',
  'CATEGORY',
  'BRAND',
  'EXTERNAL_URL',
  'DEEP_LINK',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

// ── Placements ──

export interface PlacementRow {
  id: string;
  code: string;
  name: string;
  app: string;
  page: string;
  position: string;
  aspectRatio: string;
  maxItems: number;
  isActive: boolean;
  version: number;
}

export interface PlacementRecord extends PlacementRow {
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

type PlacementEditable = Pick<
  PlacementRow,
  'name' | 'app' | 'page' | 'position' | 'aspectRatio' | 'maxItems' | 'isActive'
>;

export type CreatePlacementInput = Pick<
  PlacementRow,
  'code' | 'name' | 'app' | 'page' | 'position' | 'aspectRatio'
> &
  Partial<Pick<PlacementRow, 'maxItems' | 'isActive'>> & { reason: string };

/** `code` is immutable: clients hard-code it. */
export type UpdatePlacementInput = Partial<PlacementEditable> & { reason: string };
export type PlacementUpdateData = Partial<PlacementEditable>;

export interface AdminPlacementListQuery {
  app?: string;
  page?: string;
  position?: string;
  isActive?: boolean;
  q?: string;
  cursor?: string;
  limit: number;
}

// ── Banners ──

export interface BannerRecord {
  id: string;
  placementId: string;
  title: string;
  subtitle: string | null;
  imageUrl: string;
  mobileImageUrl: string | null;
  actionType: string;
  actionTarget: string | null;
  sortOrder: number;
  isActive: boolean;
  startDate: Date | null;
  endDate: Date | null;
  version: number;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

type BannerEditable = Pick<
  BannerRecord,
  | 'placementId'
  | 'title'
  | 'subtitle'
  | 'imageUrl'
  | 'mobileImageUrl'
  | 'actionType'
  | 'actionTarget'
  | 'sortOrder'
  | 'isActive'
  | 'startDate'
  | 'endDate'
>;

export type CreateBannerInput = Pick<BannerEditable, 'placementId' | 'title' | 'imageUrl'> &
  Partial<Omit<BannerEditable, 'placementId' | 'title' | 'imageUrl'>> & { reason: string };
export type UpdateBannerInput = Partial<BannerEditable> & { reason: string };
export type BannerUpdateData = Partial<BannerEditable>;

/** Admin list filter on the schedule, evaluated at request time. */
export type BannerState = 'LIVE' | 'SCHEDULED' | 'EXPIRED' | 'INACTIVE';

export interface AdminBannerListQuery {
  placementId?: string;
  isActive?: boolean;
  state?: BannerState;
  q?: string;
  cursor?: string;
  limit: number;
}

export interface ReorderBannersInput {
  placementId: string;
  ids: string[];
  reason: string;
}

export interface StatusInput {
  isActive: boolean;
  reason: string;
}

// ── Public snapshot (JSON-safe: dates as epoch ms, survives Redis) ──

export interface SnapshotBanner {
  id: string;
  title: string;
  subtitle: string | null;
  imageUrl: string;
  mobileImageUrl: string | null;
  actionType: string;
  actionTarget: string | null;
  sortOrder: number;
  /** epoch ms or null */
  startsAt: number | null;
  endsAt: number | null;
  version: number;
}

export interface SnapshotPlacement {
  id: string;
  code: string;
  app: string;
  page: string;
  position: string;
  aspectRatio: string;
  maxItems: number;
  version: number;
  /** Already sorted by sortOrder, then id. */
  banners: SnapshotBanner[];
}

export interface BannerSnapshot {
  placements: SnapshotPlacement[];
  etag: string;
}

export interface PublicBanner {
  id: string;
  title: string;
  subtitle: string | null;
  imageUrl: string;
  mobileImageUrl: string | null;
  actionType: string;
  actionTarget: string | null;
  sortOrder: number;
}

export interface PublicPlacement {
  code: string;
  app: string;
  page: string;
  position: string;
  aspectRatio: string;
  maxItems: number;
  banners: PublicBanner[];
}

export interface PublicBannerQuery {
  app: string;
  page?: string;
  position?: string;
}
