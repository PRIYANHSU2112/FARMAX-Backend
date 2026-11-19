import { createHash } from 'node:crypto';

import type { Breadcrumb, CategoryRow, CategorySummary } from './categories.types.js';

/**
 * Pure tree logic (no I/O). The service builds one `CategoryIndex` per cached snapshot, so
 * every public read (tree, detail, breadcrumbs, sub-categories) is in-memory map lookups.
 */

const bySiblingOrder = (a: CategoryRow, b: CategoryRow): number =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

/** Ids from the root down to the node itself, read from the materialized path. */
export const pathIds = (path: string): string[] => path.split('/').filter((id) => id !== '');

export class CategoryIndex {
  readonly byId = new Map<string, CategoryRow>();
  readonly bySlug = new Map<string, CategoryRow>();
  private readonly kids = new Map<string | null, CategoryRow[]>();
  private readonly visibleIds = new Set<string>();

  constructor(rows: readonly CategoryRow[]) {
    for (const row of rows) {
      this.byId.set(row.id, row);
      this.bySlug.set(row.slug, row);
      const siblings = this.kids.get(row.parentId);
      if (siblings === undefined) this.kids.set(row.parentId, [row]);
      else siblings.push(row);
    }
    for (const siblings of this.kids.values()) siblings.sort(bySiblingOrder);

    // Visible = active AND every ancestor active: walk down from the roots, stop at inactive nodes.
    const stack = (this.kids.get(null) ?? []).filter((row) => row.isActive);
    for (let row = stack.pop(); row !== undefined; row = stack.pop()) {
      this.visibleIds.add(row.id);
      for (const child of this.kids.get(row.id) ?? []) if (child.isActive) stack.push(child);
    }
  }

  get size(): number {
    return this.byId.size;
  }

  isVisible(id: string): boolean {
    return this.visibleIds.has(id);
  }

  /** Direct children in sibling order (`visibleOnly` = storefront). */
  children(parentId: string | null, visibleOnly: boolean): CategoryRow[] {
    const all = this.kids.get(parentId) ?? [];
    return visibleOnly ? all.filter((row) => this.visibleIds.has(row.id)) : all;
  }

  /** Root → parent, from the path (no recursion, no DB). */
  ancestors(row: CategoryRow): CategoryRow[] {
    return pathIds(row.path)
      .slice(0, -1)
      .map((id) => this.byId.get(id))
      .filter((ancestor): ancestor is CategoryRow => ancestor !== undefined);
  }

  /**
   * Nested tree under `parentId` (null = from the roots), `levels` deep (≥ 1).
   * `map` turns a row plus its already-built children into the output node.
   */
  tree<T>(
    parentId: string | null,
    levels: number,
    visibleOnly: boolean,
    map: (row: CategoryRow, children: T[], childCount: number) => T,
  ): T[] {
    if (levels < 1) return [];
    return this.children(parentId, visibleOnly).map((row) => {
      const childCount = this.children(row.id, visibleOnly).length;
      return map(row, this.tree(row.id, levels - 1, visibleOnly, map), childCount);
    });
  }
}

export const toBreadcrumb = (row: CategoryRow): Breadcrumb => ({
  id: row.id,
  name: row.name,
  nameTe: row.nameTe,
  slug: row.slug,
});

export const toSummary = (row: CategoryRow, childCount: number): CategorySummary => ({
  ...toBreadcrumb(row),
  parentId: row.parentId,
  imageUrl: row.imageUrl,
  depth: row.depth,
  sortOrder: row.sortOrder,
  childCount,
});

/** Weak ETag over (id, version) of every live row: any create/update/move/delete changes it. */
export const etagOf = (rows: readonly CategoryRow[]): string => {
  const hash = createHash('sha1');
  for (const row of rows) hash.update(`${row.id}:${String(row.version)};`);
  return `W/"${hash.digest('base64url').slice(0, 22)}"`;
};

/** URL slug from a name: ASCII lower-case words joined by `-` (Telugu-only names → `category`). */
export const slugify = (text: string): string => {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
    .replace(/-+$/, '');
  return slug === '' ? 'category' : slug;
};

/** First free slug among `base`, `base-2`, `base-3` … given the slugs already taken. */
export const firstFreeSlug = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
};

export type MoveProblem = 'CYCLE' | 'DEPTH' | null;

/**
 * Can `node` (whose deepest descendant is at `subtreeMaxDepth`) move under `newParent`?
 * CYCLE: the new parent is the node itself or inside its subtree.
 * DEPTH: the deepest moved node would reach `maxLevels` (depth is 0-based).
 */
export const checkMove = (
  node: Pick<CategoryRow, 'id' | 'path' | 'depth'>,
  newParent: Pick<CategoryRow, 'id' | 'path' | 'depth'> | null,
  subtreeMaxDepth: number,
  maxLevels: number,
): MoveProblem => {
  if (newParent?.path.startsWith(node.path) === true) return 'CYCLE';
  const newDepth = newParent === null ? 0 : newParent.depth + 1;
  const height = Math.max(subtreeMaxDepth, node.depth) - node.depth;
  return newDepth + height >= maxLevels ? 'DEPTH' : null;
};

/** The path a subtree row gets after its moved ancestor's prefix changes (mirrors the SQL). */
export const rebasePath = (path: string, oldPrefix: string, newPrefix: string): string =>
  path.startsWith(oldPrefix) ? newPrefix + path.slice(oldPrefix.length) : path;

/** Child path: parent's path (or `/` for a root) + own id. */
export const childPath = (parentPath: string | null, id: string): string =>
  `${parentPath ?? '/'}${id}/`;
