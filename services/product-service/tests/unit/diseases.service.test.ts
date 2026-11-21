import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import { describe, expect, it, vi } from 'vitest';

import { DiseasesService } from '../../src/features/products/diseases.service.js';

const actor = { userId: 'u-admin', ip: '127.0.0.1', requestId: 'req-1' };

const disease = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  name: 'Coccidiosis',
  slug: 'coccidiosis',
  description: null,
  iconUrl: null,
  iconMediaId: null,
  sortOrder: 10,
  isActive: true,
  version: 2,
  createdByUserId: 'u',
  updatedByUserId: 'u',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

const setup = () => {
  const tx = {};
  const repo = {
    activeAll: vi.fn(() =>
      Promise.resolve([disease(), disease({ id: 'd2', slug: 'crd', name: 'CRD' })]),
    ),
    productCounts: vi.fn(() => Promise.resolve(new Map([['d1', 4]]))),
    findLive: vi.fn((): Promise<ReturnType<typeof disease> | null> => Promise.resolve(disease())),
    findByIds: vi.fn(() =>
      Promise.resolve([
        { id: 'd1', name: 'Coccidiosis', isActive: true },
        { id: 'd2', name: 'CRD', isActive: false },
      ]),
    ),
    slugTaken: vi.fn(() => Promise.resolve(false)),
    slugsLike: vi.fn(() => Promise.resolve(new Set<string>())),
    nameTaken: vi.fn(() => Promise.resolve(false)),
    activeProductCount: vi.fn(() => Promise.resolve(0)),
    linkedProductSlugs: vi.fn(() => Promise.resolve(['enrocin-10'])),
    create: vi.fn((_tx: unknown, input: Record<string, unknown>) =>
      Promise.resolve(disease(input)),
    ),
    update: vi.fn((_tx: unknown, _id: string, data: object) =>
      Promise.resolve(disease({ ...data, version: 3 })),
    ),
    softDelete: vi.fn(() => Promise.resolve()),
  };
  const productsRepository = { storefrontWhere: vi.fn((f: object) => ({ visible: f })) };
  const catalogClient = {
    visibleCategoryIds: vi.fn(() => Promise.resolve(new Set(['c1']))),
    activeBrands: vi.fn(() => Promise.resolve(new Map([['b1', {}]]))),
  };
  const audit = { record: vi.fn(() => Promise.resolve()) };
  const redis = {
    get: vi.fn(() => Promise.resolve('7')),
    incr: vi.fn(() => Promise.resolve(8)),
    del: vi.fn(() => Promise.resolve(1)),
  };
  const cache = {
    getOrSet: vi.fn((_key: string, _ttl: number, load: () => Promise<unknown>) => load()),
  };
  const service = new DiseasesService({
    diseasesRepository: repo,
    productsRepository,
    catalogClient,
    runInTransaction: (work: (t: unknown) => Promise<unknown>) => work(tx),
    auditService: audit,
    cache,
    redis,
    logger: { warn: vi.fn() },
  } as never);
  return { service, repo, productsRepository, audit, redis, cache, tx };
};

describe('DiseasesService — storefront cards', () => {
  it('counts only storefront-visible products (same where as the list) and caches per list version', async () => {
    const { service, productsRepository, repo, cache } = setup();
    const cards = await service.publicList({});
    expect(productsRepository.storefrontWhere).toHaveBeenCalledWith({
      categoryIds: ['c1'],
      brandIds: ['b1'],
      attrs: [],
    });
    expect(repo.productCounts).toHaveBeenCalledWith({
      visible: { categoryIds: ['c1'], brandIds: ['b1'], attrs: [] },
    });
    expect(cards.map((c) => [c.slug, c.productCount])).toEqual([
      ['coccidiosis', 4],
      ['crd', 0],
    ]);
    expect((cache.getOrSet.mock.calls[0] as unknown[])[0]).toContain('diseases:7');
  });

  it('hideEmpty drops cards without products', async () => {
    const { service } = setup();
    const cards = await service.publicList({ hideEmpty: true });
    expect(cards.map((c) => c.slug)).toEqual(['coccidiosis']);
  });
});

describe('DiseasesService — admin writes', () => {
  it('create: slug from the name, first free suffix; audit; list version bumped', async () => {
    const { service, repo, audit, redis, tx } = setup();
    repo.slugsLike.mockResolvedValueOnce(new Set(['newcastle-disease']));
    await service.create({ name: ' Newcastle disease ', reason: 'home screen launch' }, actor);
    expect(repo.create).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ name: 'Newcastle disease', slug: 'newcastle-disease-2' }),
      'u-admin',
    );
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      actor,
      expect.objectContaining({ action: 'disease.create', targetType: 'disease' }),
    );
    expect(redis.incr).toHaveBeenCalledTimes(1);
  });

  it('create: an explicit slug used by a LIVE disease → 409 SLUG_TAKEN', async () => {
    const { service, repo } = setup();
    repo.slugTaken.mockResolvedValueOnce(true);
    await expect(
      service.create({ name: 'Cocci', slug: 'coccidiosis', reason: 'home screen launch' }, actor),
    ).rejects.toMatchObject({ details: { reason: 'SLUG_TAKEN' } });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('create: the slug of a soft-deleted disease is reusable (only live rows are checked)', async () => {
    const { service, repo } = setup();
    // repository.slugTaken filters deletedAt IS NULL → a deleted owner reports "free"
    await service.create({ name: 'Cocci', slug: 'coccidiosis', reason: 'reuse old slug' }, actor);
    expect(repo.slugTaken).toHaveBeenCalledWith(expect.anything(), 'coccidiosis', undefined);
    expect(repo.create).toHaveBeenCalled();
  });

  it('create: duplicate live name → 409', async () => {
    const { service, repo } = setup();
    repo.nameTaken.mockResolvedValueOnce(true);
    await expect(
      service.create({ name: 'Coccidiosis', reason: 'home screen launch' }, actor),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('update: version conflict → 409; success drops linked product pages', async () => {
    const { service, redis } = setup();
    await expect(
      service.update('d1', { sortOrder: 1, reason: 'reorder the cards' }, 1, actor),
    ).rejects.toMatchObject({ details: { reason: 'VERSION_CONFLICT' } });

    await service.update('d1', { iconUrl: 'https://x/i.png', reason: 'new icon' }, 2, actor);
    expect(redis.incr).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith(expect.stringContaining('enrocin-10'));
  });

  it('update: renaming the slug onto another live disease → 409', async () => {
    const { service, repo } = setup();
    repo.slugTaken.mockResolvedValueOnce(true);
    await expect(
      service.update('d1', { slug: 'crd', reason: 'merge the cards' }, undefined, actor),
    ).rejects.toMatchObject({ details: { reason: 'SLUG_TAKEN' } });
    expect(repo.slugTaken).toHaveBeenCalledWith(expect.anything(), 'crd', 'd1');
  });

  it('delete: refused while an active product is linked', async () => {
    const { service, repo } = setup();
    repo.activeProductCount.mockResolvedValueOnce(3);
    await expect(service.remove('d1', 'no longer needed', undefined, actor)).rejects.toMatchObject({
      details: { reason: 'DISEASE_IN_USE', productCount: 3 },
    });
    expect(repo.softDelete).not.toHaveBeenCalled();
  });

  it('delete: soft delete when only inactive / deleted products are linked; audited', async () => {
    const { service, repo, audit } = setup();
    await service.remove('d1', 'no longer needed', 2, actor);
    expect(repo.softDelete).toHaveBeenCalledWith(expect.anything(), 'd1', 'u-admin');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({ action: 'disease.delete', reason: 'no longer needed' }),
    );
  });

  it('delete: unknown / already deleted → 404', async () => {
    const { service, repo } = setup();
    repo.findLive.mockResolvedValueOnce(null);
    await expect(service.remove('d9', 'no longer needed', undefined, actor)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('DiseasesService — product links', () => {
  it('assertLinkable: unknown (or deleted) and inactive ids → 422 with paths', async () => {
    const { service, tx } = setup();
    await expect(service.assertLinkable(tx as never, ['d1', 'd2', 'gone'])).rejects.toMatchObject({
      details: {
        issues: [
          { path: 'diseaseIds[1]', message: '"CRD" is inactive' },
          { path: 'diseaseIds[2]', message: 'Unknown disease' },
        ],
      },
    });
    await expect(service.assertLinkable(tx as never, ['d1'])).resolves.toBeUndefined();
  });

  it('assertLinkable: error type', async () => {
    const { service, tx } = setup();
    await expect(service.assertLinkable(tx as never, ['gone'])).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
