/** Columns of the public snapshot (no audit columns: smaller cache payload). */
export interface BrandRow {
  id: string;
  name: string;
  slug: string;
  code: string;
  description: string | null;
  logoUrl: string | null;
  bannerUrl: string | null;
  websiteUrl: string | null;
  countryOfOrigin: string | null;
  isFeatured: boolean;
  isActive: boolean;
  sortOrder: number;
  version: number;
}

/** Storefront view: no internal flags. */
export type PublicBrand = Omit<BrandRow, 'isActive' | 'version'>;

/** Every live, active brand in display order + its ETag (one Redis key). */
export interface BrandSnapshot {
  rows: BrandRow[];
  etag: string;
}

/** Admin view: a live brand with audit columns. */
export interface BrandRecord extends BrandRow {
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface BrandListQuery {
  q?: string;
  isFeatured?: boolean;
  cursor?: string;
  limit: number;
}

export interface AdminBrandListQuery extends BrandListQuery {
  isActive?: boolean;
}

type Editable = Pick<
  BrandRow,
  | 'name'
  | 'slug'
  | 'code'
  | 'description'
  | 'logoUrl'
  | 'bannerUrl'
  | 'websiteUrl'
  | 'countryOfOrigin'
  | 'isFeatured'
  | 'isActive'
  | 'sortOrder'
>;

export type CreateBrandInput = Pick<Editable, 'name' | 'code'> &
  Partial<Omit<Editable, 'name' | 'code'>> & { reason: string };

export type UpdateBrandInput = Partial<Editable> & { reason: string };

export interface SetBrandStatusInput {
  isActive?: boolean;
  isFeatured?: boolean;
  reason: string;
}

export type BrandUpdateData = Partial<Editable>;
