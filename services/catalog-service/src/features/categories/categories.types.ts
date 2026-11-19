import type { CursorQuery } from '@farmx/common/types';

/** One live category as held in the tree cache (JSON-safe, no dates). */
export interface CategoryRow {
  id: string;
  parentId: string | null;
  /** `/<rootId>/…/<id>/` */
  path: string;
  depth: number;
  name: string;
  nameTe: string | null;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  sortOrder: number;
  isActive: boolean;
  version: number;
}

/** Cached snapshot of every live category. `etag` changes whenever any row changes. */
export interface TreeSnapshot {
  rows: CategoryRow[];
  etag: string;
}

// ── Public (storefront) views ──

export interface Breadcrumb {
  id: string;
  name: string;
  nameTe: string | null;
  slug: string;
}

export interface CategorySummary extends Breadcrumb {
  parentId: string | null;
  imageUrl: string | null;
  depth: number;
  sortOrder: number;
  /** Visible direct sub-categories. */
  childCount: number;
}

export interface CategoryNode extends CategorySummary {
  children: CategoryNode[];
}

export interface PublicCategoryDetail {
  category: CategorySummary & { description: string | null };
  /** Root → parent (the category itself is not included). */
  breadcrumbs: Breadcrumb[];
  children: CategorySummary[];
}

// ── Admin views ──

export interface AdminCategory extends CategoryRow {
  /** Live direct sub-categories (active or not). */
  childCount: number;
  /** isActive of this node AND every ancestor: what the storefront actually shows. */
  effectiveActive: boolean;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminCategoryDetail extends AdminCategory {
  ancestors: Breadcrumb[];
  children: (CategorySummary & { isActive: boolean })[];
}

export interface AdminTreeNode extends CategorySummary {
  isActive: boolean;
  effectiveActive: boolean;
  children: AdminTreeNode[];
}

// ── Inputs ──

interface Reasoned {
  /** Why (10–500 chars). Stored in the audit log. */
  reason: string;
}

export interface CategoryFields {
  name: string;
  nameTe?: string | null;
  slug?: string;
  description?: string | null;
  imageUrl?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

export interface CreateCategoryInput extends CategoryFields, Reasoned {
  /** null / omitted = root category; set = sub-category of that parent. */
  parentId?: string | null;
}

export type UpdateCategoryInput = Partial<CategoryFields> & Reasoned;

export interface MoveCategoryInput extends Reasoned {
  parentId: string | null;
  sortOrder?: number;
}

export interface ReorderCategoriesInput extends Reasoned {
  parentId: string | null;
  orderedIds: string[];
}

export interface AdminCategoryListQuery extends CursorQuery {
  /** `root` = top level; a uuid = direct children of that category; omitted = all levels. */
  parentId?: string;
  q?: string;
  isActive?: boolean;
}

export interface TreeQuery {
  /** Levels to return below the starting point (1 = direct children only). */
  maxDepth?: number;
}
