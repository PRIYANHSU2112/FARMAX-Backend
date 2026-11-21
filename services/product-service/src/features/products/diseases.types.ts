export interface DiseaseRecord {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  iconUrl: string | null;
  iconMediaId: string | null;
  sortOrder: number;
  isActive: boolean;
  version: number;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Disease linked to a product (product detail). */
export type DiseaseRef = Pick<DiseaseRecord, 'id' | 'name' | 'slug' | 'iconUrl'>;

/** "Shop by Problem" card: `productCount` = storefront-visible products only. */
export interface PublicDisease {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  iconUrl: string | null;
  productCount: number;
}

export interface PublicDiseaseQuery {
  /** true = leave out cards with no visible product. */
  hideEmpty?: boolean;
}

export interface DiseaseListQuery {
  q?: string;
  isActive?: boolean;
}

export interface CreateDiseaseInput {
  name: string;
  /** Generated from the name when omitted (first free `-2`, `-3` … suffix). */
  slug?: string;
  description?: string | null;
  iconUrl?: string | null;
  iconMediaId?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  reason: string;
}

export type UpdateDiseaseInput = Partial<Omit<CreateDiseaseInput, 'reason'>> & { reason: string };
