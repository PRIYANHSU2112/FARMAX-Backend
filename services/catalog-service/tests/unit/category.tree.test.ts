import { describe, expect, it } from 'vitest';

import type { CategoryRow } from '../../src/features/categories/categories.types.js';
import {
  CategoryIndex,
  checkMove,
  childPath,
  etagOf,
  firstFreeSlug,
  rebasePath,
  slugify,
} from '../../src/features/categories/category.tree.js';

const row = (
  id: string,
  parent: CategoryRow | null,
  extra: Partial<CategoryRow> = {},
): CategoryRow => ({
  id,
  parentId: parent?.id ?? null,
  path: childPath(parent?.path ?? null, id),
  depth: parent === null ? 0 : parent.depth + 1,
  name: id.toUpperCase(),
  nameTe: null,
  slug: id,
  description: null,
  imageUrl: null,
  sortOrder: 0,
  isActive: true,
  version: 0,
  ...extra,
});

// a → b → c → d → e (5 levels) · a → f · g (second root, inactive)
const a = row('a', null, { sortOrder: 10 });
const b = row('b', a, { sortOrder: 20 });
const f = row('f', a, { sortOrder: 10 });
const c = row('c', b);
const d = row('d', c);
const e = row('e', d);
const g = row('g', null, { sortOrder: 20, isActive: false });
const rows = [a, b, c, d, e, f, g];

describe('CategoryIndex', () => {
  const index = new CategoryIndex(rows);

  it('builds an arbitrarily deep nested tree in sibling order', () => {
    interface N {
      id: string;
      children: N[];
    }
    const tree = index.tree<N>(null, 10, false, (r, children) => ({ id: r.id, children }));
    expect(tree.map((n) => n.id)).toEqual(['a', 'g']);
    expect(tree[0]?.children.map((n) => n.id)).toEqual(['f', 'b']);
    expect(tree[0]?.children[1]?.children[0]?.children[0]?.children[0]?.id).toBe('e');
  });

  it('limits the number of levels', () => {
    interface N {
      id: string;
      children: N[];
    }
    const tree = index.tree<N>(null, 1, true, (r, children) => ({ id: r.id, children }));
    expect(tree).toEqual([{ id: 'a', children: [] }]);
  });

  it('hides a whole subtree when an ancestor is inactive', () => {
    const hidden = new CategoryIndex(
      rows.map((r) => (r.id === 'b' ? { ...r, isActive: false } : r)),
    );
    expect(hidden.isVisible('a')).toBe(true);
    for (const id of ['b', 'c', 'd', 'e']) expect(hidden.isVisible(id)).toBe(false);
    expect(hidden.isVisible('g')).toBe(false);
    expect(hidden.children('a', true).map((r) => r.id)).toEqual(['f']);
  });

  it('reads breadcrumbs from the materialized path', () => {
    expect(index.ancestors(e).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(index.ancestors(a)).toEqual([]);
  });
});

describe('move rules', () => {
  it('refuses moving a node under itself or a descendant (cycle)', () => {
    expect(checkMove(b, b, 4, 10)).toBe('CYCLE');
    expect(checkMove(b, d, 4, 10)).toBe('CYCLE');
  });

  it('refuses a move that would push the branch past the depth limit', () => {
    // b's branch is 4 levels (b..e at depth 1..4); under f (depth 1) it would end at depth 5.
    expect(checkMove(b, f, 4, 5)).toBe('DEPTH');
    expect(checkMove(b, f, 4, 6)).toBeNull();
  });

  it('allows moving to the root', () => {
    expect(checkMove(c, null, 4, 10)).toBeNull();
  });

  it('rebases descendant paths like the SQL does', () => {
    const newPrefix = childPath(f.path, 'b');
    expect(rebasePath(e.path, b.path, newPrefix)).toBe('/a/f/b/c/d/e/');
    expect(rebasePath(g.path, b.path, newPrefix)).toBe(g.path);
  });
});

describe('slugs and etag', () => {
  it('slugifies names', () => {
    expect(slugify('Live Vaccines')).toBe('live-vaccines');
    expect(slugify('  Feed & Supplements!! ')).toBe('feed-and-supplements');
    expect(slugify('Vitamines Éclair')).toBe('vitamines-eclair');
    expect(slugify('టీకాలు')).toBe('category');
  });

  it('picks the first free slug', () => {
    expect(firstFreeSlug('vaccines', new Set())).toBe('vaccines');
    expect(firstFreeSlug('vaccines', new Set(['vaccines', 'vaccines-2']))).toBe('vaccines-3');
  });

  it('changes the etag when any row version changes', () => {
    const before = etagOf(rows);
    expect(etagOf(rows)).toBe(before);
    expect(etagOf(rows.map((r) => (r.id === 'e' ? { ...r, version: 1 } : r)))).not.toBe(before);
    expect(before).toMatch(/^W\/".+"$/);
  });
});
