import { ConflictError, NotFoundError } from '@farmx/common/errors';
import { describe, expect, it, vi } from 'vitest';

import {
  BrandsService,
  etagOf,
  filterBrands,
  firstFreeSlug,
  slugify,
} from '../../src/features/brands/brands.service.js';
import type { BrandRecord, BrandRow } from '../../src/features/brands/brands.types.js';

const brand = (id: string, slug: string, extra: Partial<BrandRow> = {}): BrandRow => ({
  id,
  name: slug,
  slug,
  code: slug.toUpperCase(),
  description: null,
  logoUrl: null,
  bannerUrl: null,
  websiteUrl: null,
  countryOfOrigin: null,
  isFeatured: false,
  isActive: true,
  sortOrder: 0,
  version: 0,
  ...extra,
});
const A = '01900000-0000-7000-8000-000000000201';
const B = '01900000-0000-7000-8000-000000000202';
const C = '01900000-0000-7000-8000-000000000203';
const rows = [brand(A, 'zoetis', { isFeatured: true }), brand(B, 'venkys'), brand(C, 'zydus')];
const record = (row: BrandRow): BrandRecord => ({
  ...row,
  createdByUserId: A,
  updatedByUserId: A,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});
const actor = { userId: A, ip: '127.0.0.1', requestId: 'req-1' };

const setup = (overrides: Record<string, unknown> = {}) => {
  const repo = {
    lock: vi.fn(() => Promise.resolve()),
    loadActive: vi.fn(() => Promise.resolve(rows)),
    findLive: vi.fn((id: string) => {
      const row = rows.find((r) => r.id === id);
      return Promise.resolve(row === undefined ? null : record(row));
    }),
    conflicts: vi.fn(() => Promise.resolve([] as string[])),
    slugsStartingWith: vi.fn(() => Promise.resolve(new Set<string>())),
    create: vi.fn((_tx: unknown, data: Omit<BrandRow, 'version'>) =>
      Promise.resolve(record({ ...data, version: 0 })),
    ),
    update: vi.fn((_tx: unknown, id: string, data: Partial<BrandRow>) =>
      Promise.resolve(record({ ...rows.find((r) => r.id === id)!, ...data, version: 1 })),
    ),
    softDelete: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
  const cache = {
    getOrSet: vi.fn((_k: string, _t: number, load: () => Promise<unknown>) => load()),
    invalidate: vi.fn(() => Promise.resolve()),
  };
  const audit = { record: vi.fn(() => Promise.resolve()), history: vi.fn() };
  const tx = { outboxEvent: { create: vi.fn(() => Promise.resolve()) } };
  const productClient = {
    block: vi.fn(() => Promise.resolve()),
    unblock: vi.fn(() => Promise.resolve()),
  };
  const service = new BrandsService({
    brandsRepository: repo,
    cache,
    runInTransaction: (work: (t: unknown) => Promise<unknown>) => work(tx),
    auditService: audit,
    productClient,
  } as never);
  return { service, repo, cache, audit, tx, productClient };
};

describe('brand helpers', () => {
  it('slugify / firstFreeSlug', () => {
    expect(slugify("Venky's Animal Health")).toBe('venky-s-animal-health');
    expect(slugify('Hipra & Co.')).toBe('hipra-and-co');
    expect(firstFreeSlug('zoetis', new Set(['zoetis', 'zoetis-2']))).toBe('zoetis-3');
  });

  it('etag changes with any version', () => {
    expect(etagOf(rows)).not.toBe(etagOf([{ ...rows[0]!, version: 1 }, ...rows.slice(1)]));
  });

  it('filters by q and isFeatured, pages by cursor', () => {
    expect(filterBrands(rows, { q: 'Z', limit: 20 }).items.map((r) => r.slug)).toEqual([
      'zoetis',
      'zydus',
    ]);
    expect(filterBrands(rows, { isFeatured: true, limit: 20 }).items.map((r) => r.id)).toEqual([A]);
    const first = filterBrands(rows, { limit: 2 });
    expect(first.nextCursor).toBe(B);
    expect(filterBrands(rows, { cursor: B, limit: 2 }).items.map((r) => r.id)).toEqual([C]);
  });
});

describe('BrandsService', () => {
  it('public reads hit the cache once (in-process snapshot after that)', async () => {
    const { service, cache, repo } = setup();
    await service.publicList({ limit: 20 });
    await service.publicDetail('zoetis');
    expect(cache.getOrSet).toHaveBeenCalledTimes(1);
    expect(repo.loadActive).toHaveBeenCalledTimes(1);
  });

  it('public detail resolves slug or id; strips internal fields; unknown → 404', async () => {
    const { service } = setup();
    const bySlug = await service.publicDetail('venkys');
    const byId = await service.publicDetail(B);
    expect(bySlug.data).toEqual(byId.data);
    expect(bySlug.data).not.toHaveProperty('version');
    await expect(service.publicDetail('nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('create generates a slug, audits and invalidates the cache', async () => {
    const { service, repo, cache, audit } = setup();
    const created = await service.create(
      { name: 'Hipra Labs', code: 'HIPRA', reason: 'onboard brand' },
      actor,
    );
    expect(created.slug).toBe('hipra-labs');
    expect(repo.lock).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({ action: 'brand.create', targetType: 'brand' }),
    );
    expect(cache.invalidate).toHaveBeenCalled();
  });

  it('duplicate name/slug/code → 409 with the clashing fields', async () => {
    const { service } = setup({ conflicts: vi.fn(() => Promise.resolve(['code'])) });
    await expect(
      service.create({ name: 'Zoetis 2', code: 'ZOETIS', reason: 'onboard brand' }, actor),
    ).rejects.toMatchObject({ details: { reason: 'BRAND_DUPLICATE', fields: ['code'] } });
  });

  it('stale If-Match → 409 BRAND_VERSION_CONFLICT', async () => {
    const { service } = setup();
    await expect(
      service.setStatus(A, { isActive: false, reason: 'hide this brand' }, 5, actor),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('status change writes only changed fields; no-op skips the write', async () => {
    const { service, repo, audit } = setup();
    await service.setStatus(
      B,
      { isFeatured: true, isActive: true, reason: 'feature it now' },
      0,
      actor,
    );
    expect(repo.update).toHaveBeenCalledWith(expect.anything(), B, { isFeatured: true }, A);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({ action: 'brand.status' }),
    );
    repo.update.mockClear();
    await service.update(B, { name: 'venkys', reason: 'no real change' }, undefined, actor);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('remove asks product-service to block first; a failed delete unblocks (plan §E)', async () => {
    const { service, productClient, tx } = setup();
    await service.remove(C, 'brand discontinued', undefined, actor);
    expect(productClient.block).toHaveBeenCalledWith('BRAND', C);
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
    const missing = '01900000-0000-7000-8000-000000000299';
    await expect(
      service.remove(missing, 'brand discontinued', undefined, actor),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(productClient.unblock).toHaveBeenCalledWith('BRAND', missing);
    productClient.block.mockRejectedValueOnce(new Error('used by products'));
    await expect(service.remove(C, 'brand discontinued', undefined, actor)).rejects.toThrow(
      'used by products',
    );
  });

  it('a rename emits catalog.brand_updated.v1; a featured toggle does not', async () => {
    const { service, tx } = setup();
    await service.setStatus(B, { isFeatured: true, reason: 'feature it now' }, undefined, actor);
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    await service.update(B, { name: 'Venkys AH', reason: 'brand renamed' }, undefined, actor);
    const types = tx.outboxEvent.create.mock.calls.map(
      (call) => (call as unknown as [{ data: { type: string } }])[0].data.type,
    );
    expect(types).toEqual(['catalog.brand_updated.v1']);
  });

  it('remove soft-deletes, audits; unknown id → 404', async () => {
    const { service, repo } = setup();
    await service.remove(C, 'brand discontinued', undefined, actor);
    expect(repo.softDelete).toHaveBeenCalledWith(expect.anything(), C, A);
    await expect(
      service.remove(
        '01900000-0000-7000-8000-000000000299',
        'brand discontinued',
        undefined,
        actor,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
