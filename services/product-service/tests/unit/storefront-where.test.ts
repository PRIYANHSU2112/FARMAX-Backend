import { describe, expect, it } from 'vitest';

import { ProductsRepository } from '../../src/features/products/products.repository.js';

const repo = new ProductsRepository({ db: {} as never });

describe('storefrontWhere — Shop by Problem + flock stage', () => {
  it('always restricts to visible products (published, active, live, active variant)', () => {
    const where = repo.storefrontWhere({ attrs: [] });
    expect(where).toMatchObject({
      deletedAt: null,
      status: 'PUBLISHED',
      isActive: true,
      variants: { some: { deletedAt: null, isActive: true } },
    });
    expect(where).not.toHaveProperty('diseases');
    expect(where).not.toHaveProperty('productionStages');
  });

  it('disease filter only matches live + active diseases; flock stage uses hasSome', () => {
    const where = repo.storefrontWhere({
      diseaseIds: ['d1'],
      flockStages: ['GROWER', 'LAYER'],
      species: ['BROILER'],
      attrs: [],
    });
    expect(where).toMatchObject({
      status: 'PUBLISHED',
      diseases: {
        some: { diseaseId: { in: ['d1'] }, disease: { deletedAt: null, isActive: true } },
      },
      productionStages: { hasSome: ['GROWER', 'LAYER'] },
      species: { some: { lookup: { code: { in: ['BROILER'] } } } },
    });
  });
});

describe('storefrontWhere — stock filters', () => {
  it('inStock without a node uses the network projection', () => {
    expect(repo.storefrontWhere({ inStock: true, attrs: [] }).variants).toEqual({
      some: { deletedAt: null, isActive: true, availability: { inStock: true } },
    });
  });

  it('inStock + nodeId requires stock at that node; nodeId alone does nothing', () => {
    expect(repo.storefrontWhere({ inStock: true, nodeId: 'n1', attrs: [] }).variants).toEqual({
      some: {
        deletedAt: null,
        isActive: true,
        nodeAvailability: { some: { nodeId: 'n1', inStock: true } },
      },
    });
    expect(repo.storefrontWhere({ nodeId: 'n1', attrs: [] }).variants).toEqual({
      some: { deletedAt: null, isActive: true },
    });
  });
});
