import { ConflictError, ForbiddenError, ValidationError } from '@farmx/common/errors';
import { describe, expect, it, vi } from 'vitest';

import { ProductsService } from '../../src/features/products/products.service.js';

const D = (v: string | number) => ({ toString: () => String(v) });
const actor = { userId: 'u-admin', ip: '127.0.0.1', requestId: 'req-1' };
const NO_PROFILE = {
  requiresRegistration: false,
  requiresDrugLicense: false,
  requiresManufacturingLicense: false,
  requiresWithdrawal: false,
  requiresColdChain: false,
  requiredDocTypes: [],
  allowedSchedules: [],
};

const variant = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  productId: 'p1',
  sku: `SKU-${id}`,
  barcode: null,
  name: id,
  packSize: D(100),
  packUnit: { id: 'ml', code: 'ML', label: 'ml' },
  unitsPerPack: 1,
  mrp: D(185),
  minOrderQty: 1,
  maxOrderQty: null,
  isB2cEligible: false,
  weightGrams: null,
  lengthMm: null,
  widthMm: null,
  heightMm: null,
  hsnCode: null,
  gstRate: null,
  isDefault: false,
  isActive: true,
  sortOrder: 10,
  version: 0,
  price: null,
  availability: null,
  ...over,
});

const product = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'Enrocin 10%',
  slug: 'enrocin-10',
  productCode: 'FXP-000001',
  shortDescription: null,
  description: null,
  categoryId: 'c1',
  brandId: 'b1',
  brandName: 'Venky’s',
  genericName: null,
  dosageForm: null,
  routes: [],
  species: [],
  productionStages: [],
  diseases: [],
  indications: null,
  dosageInstructions: null,
  contraindications: null,
  sideEffects: null,
  precautions: null,
  withdrawalMeatDays: null,
  withdrawalEggDays: null,
  manufacturerName: 'Venky’s (India) Ltd.',
  manufacturerAddress: null,
  marketerName: null,
  drugSchedule: 'OTC',
  registrationAuthority: null,
  registrationNo: null,
  drugLicenseNo: null,
  manufacturingLicenseNo: null,
  isPrescriptionRequired: false,
  isVetConsultRequired: false,
  isAntimicrobial: false,
  temperatureClass: 'AMB',
  storageMinTempC: null,
  storageMaxTempC: null,
  isFreezeSensitive: false,
  isLightSensitive: false,
  isHumiditySensitive: false,
  storageInstructions: null,
  shelfLifeMonths: null,
  hazardClass: null,
  unNumber: null,
  hsnCode: '30042019',
  gstRate: D(12),
  countryOfOrigin: null,
  tags: [],
  seoTitle: null,
  seoDescription: null,
  attributes: {},
  isFeatured: false,
  isActive: true,
  status: 'DRAFT',
  submittedByUserId: null,
  submittedAt: null,
  publishedByUserId: null,
  publishedAt: null,
  minPrice: null,
  maxPrice: null,
  maxDiscountPercent: null,
  ratingAvg: null,
  ratingCount: 0,
  version: 3,
  createdByUserId: 'u',
  updatedByUserId: 'u',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ingredients: [],
  variants: [variant('v1', { isDefault: true })],
  media: [
    {
      id: 'm1',
      variantId: null,
      kind: 'IMAGE',
      docType: null,
      url: 'https://x/y.webp',
      mediaId: null,
      title: null,
      sortOrder: 0,
      isPrimary: true,
    },
  ],
  ...over,
});

const setup = (record = product()) => {
  const tx = { outboxEvent: { create: vi.fn(() => Promise.resolve()) } };
  const repo = {
    lockProduct: vi.fn(() => Promise.resolve(true)),
    findDetail: vi.fn(() => Promise.resolve(record)),
    create: vi.fn(() => Promise.resolve()),
    update: vi.fn(() => Promise.resolve()),
    touch: vi.fn(() => Promise.resolve()),
    setStatus: vi.fn(() => Promise.resolve()),
    nextProductSeq: vi.fn(() => Promise.resolve(42n)),
    slugsStartingWith: vi.fn(() => Promise.resolve(new Set<string>())),
    slugTaken: vi.fn(() => Promise.resolve(false)),
    variantKeyConflicts: vi.fn(() =>
      Promise.resolve({ skus: [] as string[], barcodes: [] as string[] }),
    ),
    lockReferenceShared: vi.fn(() => Promise.resolve()),
    lockReferenceExclusive: vi.fn(() => Promise.resolve()),
    isBlocked: vi.fn(() => Promise.resolve(false)),
    countUsing: vi.fn(() => Promise.resolve(0)),
    block: vi.fn(() => Promise.resolve()),
    updateVariant: vi.fn((_tx: unknown, id: string, data: object) =>
      Promise.resolve({ ...variant(id), ...data, version: 1 }),
    ),
    softDeleteVariant: vi.fn(() => Promise.resolve()),
    pricedVariants: vi.fn(() => Promise.resolve([])),
    setPriceSummary: vi.fn(() => Promise.resolve()),
  };
  const audit = { record: vi.fn(() => Promise.resolve()), history: vi.fn() };
  const lookups = {
    resolve: vi.fn(() => Promise.resolve(new Map())),
    resolveCodes: vi.fn((): Promise<void> => Promise.resolve()),
    publicList: vi.fn(() =>
      Promise.resolve([
        { id: 'l-g', group: 'FLOCK_STAGE', code: 'GROWER', label: 'Grower', meta: {} },
      ]),
    ),
  };
  const diseases = { assertLinkable: vi.fn((): Promise<void> => Promise.resolve()) };
  const service = new ProductsService({
    productsRepository: repo,
    lookupsService: lookups,
    diseasesService: diseases,
    attributesService: {
      effectiveFor: vi.fn(() => Promise.resolve([])),
      complianceFor: vi.fn(() => Promise.resolve(NO_PROFILE)),
    },
    catalogClient: {
      assertAssignableCategory: vi.fn(() => Promise.resolve({ pathIds: ['c1'] })),
      assertAssignableBrand: vi.fn(() => Promise.resolve({ id: 'b1', name: 'Venky’s' })),
      categoryContext: vi.fn(() => Promise.resolve({ pathIds: ['c1'] })),
    },
    runInTransaction: (work: (t: unknown) => Promise<unknown>) => work(tx),
    auditService: audit,
    redis: { incr: vi.fn(() => Promise.resolve(1)), del: vi.fn(() => Promise.resolve(1)) },
    logger: { warn: vi.fn() },
  } as never);
  return { service, repo, audit, tx, lookups, diseases };
};

const variantInput = (sku: string, over: Record<string, unknown> = {}) => ({
  sku,
  name: sku,
  packSize: 100,
  packUnitId: 'ml',
  mrp: 185,
  ...over,
});

describe('ProductsService — create', () => {
  it('first active variant becomes the default; code, slug, audit and one event per variant', async () => {
    const { service, repo, audit, tx } = setup(
      product({ variants: [variant('v1', { isDefault: true }), variant('v2')] }),
    );
    await service.create(
      {
        name: 'Enrocin 10% Oral',
        categoryId: 'c1',
        brandId: 'b1',
        hsnCode: '30042019',
        gstRate: 12,
        drugSchedule: 'H',
        variants: [variantInput('A', { isActive: false }), variantInput('B')],
        reason: 'new listing for CRD',
      },
      actor,
    );
    const [, data, relations] = repo.create.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
      { variants: { isDefault: boolean }[] },
    ];
    expect(relations.variants.map((v) => v.isDefault)).toEqual([false, true]);
    expect(data).toMatchObject({
      productCode: 'FXP-000042',
      slug: 'enrocin-10-pct-oral',
      brandName: 'Venky’s',
      isPrescriptionRequired: true,
    });
    expect(repo.lockReferenceShared).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      actor,
      expect.objectContaining({ action: 'product.create' }),
    );
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(2);
  });

  it('rejects two defaults and duplicate SKUs in the request; blocked category → 422', async () => {
    const { service, repo } = setup();
    const base = {
      name: 'X product',
      categoryId: 'c1',
      brandId: 'b1',
      hsnCode: '3004',
      gstRate: 12,
      reason: 'new listing x',
    };
    await expect(
      service.create(
        {
          ...base,
          variants: [
            variantInput('A', { isDefault: true }),
            variantInput('B', { isDefault: true }),
          ],
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.create({ ...base, variants: [variantInput('A'), variantInput('A')] }, actor),
    ).rejects.toBeInstanceOf(ValidationError);
    repo.isBlocked.mockResolvedValueOnce(true);
    await expect(
      service.create({ ...base, variants: [variantInput('A')] }, actor),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('SKU taken by another product → 409 PRODUCT_DUPLICATE', async () => {
    const { service, repo } = setup();
    repo.variantKeyConflicts.mockResolvedValueOnce({ skus: ['A'], barcodes: [] });
    await expect(
      service.create(
        {
          name: 'X product',
          categoryId: 'c1',
          brandId: 'b1',
          hsnCode: '3004',
          gstRate: 12,
          variants: [variantInput('A')],
          reason: 'new listing x',
        },
        actor,
      ),
    ).rejects.toMatchObject({ details: { reason: 'PRODUCT_DUPLICATE', fields: ['sku'] } });
  });
});

describe('ProductsService — flock stages + Shop by Problem links', () => {
  const base = {
    name: 'Coccicure',
    categoryId: 'c1',
    brandId: 'b1',
    hsnCode: '30042019',
    gstRate: 12,
    variants: [variantInput('A')],
    reason: 'new listing for coccidiosis',
  };

  it('create: validates FLOCK_STAGE codes + diseases in the tx and stores the links', async () => {
    const { service, repo, lookups, diseases, tx } = setup();
    await service.create(
      { ...base, productionStages: ['GROWER'], diseaseIds: ['d1', 'd2'] },
      actor,
    );
    expect(lookups.resolveCodes).toHaveBeenCalledWith(
      tx,
      'FLOCK_STAGE',
      ['GROWER'],
      'productionStages',
    );
    expect(diseases.assertLinkable).toHaveBeenCalledWith(tx, ['d1', 'd2']);
    const [, data, relations] = repo.create.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
      { diseaseIds: string[] },
    ];
    expect(relations.diseaseIds).toEqual(['d1', 'd2']);
    expect(data.productionStages).toEqual(['GROWER']);
    expect(data).not.toHaveProperty('diseaseIds');
  });

  it('create: unknown / inactive stage code → 422, nothing written', async () => {
    const { service, repo, lookups } = setup();
    lookups.resolveCodes.mockRejectedValueOnce(
      new ValidationError([{ path: 'productionStages[0]', message: 'Unknown FLOCK_STAGE code' }]),
    );
    await expect(
      service.create({ ...base, productionStages: ['NOPE'] }, actor),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('create: inactive / deleted disease → 422', async () => {
    const { service, repo, diseases } = setup();
    diseases.assertLinkable.mockRejectedValueOnce(
      new ValidationError([{ path: 'diseaseIds[0]', message: 'Unknown disease' }]),
    );
    await expect(service.create({ ...base, diseaseIds: ['gone'] }, actor)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('update: diseaseIds replace the links; omitted = links unchanged and not re-validated', async () => {
    const { service, repo, diseases } = setup();
    await service.update('p1', { diseaseIds: ['d3'], reason: 'relink to CRD only' }, 3, actor);
    expect(diseases.assertLinkable).toHaveBeenCalledTimes(1);
    expect((repo.update.mock.calls[0] as unknown as unknown[])[3]).toMatchObject({
      diseaseIds: ['d3'],
    });

    await service.update(
      'p1',
      { name: 'Coccicure Plus', reason: 'rename for the label' },
      3,
      actor,
    );
    expect(diseases.assertLinkable).toHaveBeenCalledTimes(1);
    expect((repo.update.mock.calls[1] as unknown as unknown[])[3]).toMatchObject({
      diseaseIds: undefined,
    });
  });

  it('views: flock stages carry labels (legacy text keeps its raw value); diseases listed', async () => {
    const { service } = setup(
      product({
        productionStages: ['GROWER', 'grower-old'],
        diseases: [{ disease: { id: 'd1', name: 'CRD', slug: 'crd', iconUrl: null } }],
      }),
    );
    const view = await service.detail('p1');
    expect(view.flockStages).toEqual([
      { code: 'GROWER', label: 'Grower' },
      { code: 'grower-old', label: 'grower-old' },
    ]);
    expect(view.diseases).toEqual([{ id: 'd1', name: 'CRD', slug: 'crd', iconUrl: null }]);
  });
});

describe('ProductsService — variant invariants', () => {
  it('cannot remove or deactivate the last active variant', async () => {
    const { service } = setup();
    await expect(
      service.removeVariant('p1', 'v1', { reason: 'remove pack' }, undefined, actor),
    ).rejects.toMatchObject({ details: { reason: 'LAST_VARIANT' } });
    await expect(
      service.updateVariant('p1', 'v1', { isActive: false, reason: 'stop pack' }, undefined, actor),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('removing the default promotes the lowest-sort active variant', async () => {
    const { service, repo } = setup(
      product({
        variants: [
          variant('v1', { isDefault: true }),
          variant('v3', { sortOrder: 30 }),
          variant('v2', { sortOrder: 20 }),
        ],
      }),
    );
    await service.removeVariant('p1', 'v1', { reason: 'pack discontinued' }, undefined, actor);
    expect(repo.softDeleteVariant).toHaveBeenCalledWith(expect.anything(), 'v1', actor.userId);
    expect(repo.updateVariant).toHaveBeenCalledWith(
      expect.anything(),
      'v2',
      { isDefault: true },
      actor.userId,
    );
  });

  it('deactivating the default clears its flag and promotes another', async () => {
    const { service, repo } = setup(
      product({ variants: [variant('v1', { isDefault: true }), variant('v2', { sortOrder: 20 })] }),
    );
    await service.updateVariant(
      'p1',
      'v1',
      { isActive: false, reason: 'temporarily off' },
      undefined,
      actor,
    );
    expect(repo.updateVariant).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'v1',
      { isActive: false, isDefault: false },
      actor.userId,
    );
    expect(repo.updateVariant).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'v2',
      { isDefault: true },
      actor.userId,
    );
  });

  it('set default unsets the old one first (partial unique index)', async () => {
    const { service, repo } = setup(
      product({ variants: [variant('v1', { isDefault: true }), variant('v2')] }),
    );
    await service.setDefaultVariant('p1', 'v2', 'best seller pack', undefined, actor);
    expect(repo.updateVariant.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['v1', { isDefault: false }],
      ['v2', { isDefault: true }],
    ]);
  });

  it('stale If-Match on the product → 409', async () => {
    const { service } = setup();
    await expect(
      service.setDefaultVariant('p1', 'v1', 'best seller pack', 9, actor),
    ).rejects.toMatchObject({ details: { reason: 'VERSION_CONFLICT' } });
  });
});

describe('ProductsService — workflow', () => {
  it('submit runs compliance (Schedule H without licences → 422)', async () => {
    const { service } = setup(product({ drugSchedule: 'H', isPrescriptionRequired: true }));
    await expect(
      service.transition('p1', 'submit', 'ready for review', undefined, actor),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('a compliant draft is submitted with submitter recorded', async () => {
    const { service, repo } = setup();
    await service.transition('p1', 'submit', 'ready for review', undefined, actor);
    expect(repo.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      'p1',
      'PENDING_REVIEW',
      expect.objectContaining({ submittedByUserId: actor.userId }),
      actor.userId,
    );
  });

  it('approver must differ from submitter; invalid transitions → 409', async () => {
    const pending = setup(product({ status: 'PENDING_REVIEW', submittedByUserId: actor.userId }));
    await expect(
      pending.service.transition('p1', 'approve', 'looks good to me', undefined, actor),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const draft = setup();
    await expect(
      draft.service.transition('p1', 'suspend', 'not allowed here', undefined, actor),
    ).rejects.toMatchObject({ details: { reason: 'INVALID_TRANSITION' } });
  });

  it('approve by another user publishes and emits product.published.v1', async () => {
    const { service, repo, tx } = setup(
      product({ status: 'PENDING_REVIEW', submittedByUserId: 'someone-else' }),
    );
    await service.transition('p1', 'approve', 'dossier verified', undefined, actor);
    expect(repo.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      'p1',
      'PUBLISHED',
      expect.objectContaining({ publishedByUserId: actor.userId }),
      actor.userId,
    );
    const types = tx.outboxEvent.create.mock.calls.map(
      (call) => (call as unknown as [{ data: { type: string } }])[0].data.type,
    );
    expect(types).toContain('product.published.v1');
  });

  it('published products cannot be deleted', async () => {
    const { service } = setup(product({ status: 'PUBLISHED' }));
    await expect(service.remove('p1', 'cleanup listing', undefined, actor)).rejects.toMatchObject({
      details: { reason: 'NOT_DELETABLE' },
    });
  });
});

describe('ProductsService — safe reference delete (plan §E)', () => {
  it('blocks only when unused, under the exclusive lock', async () => {
    const { service, repo } = setup();
    repo.countUsing.mockResolvedValueOnce(3);
    await expect(service.blockReference('CATEGORY', 'c1')).rejects.toMatchObject({
      details: { reason: 'IN_USE', count: 3 },
    });
    expect(repo.block).not.toHaveBeenCalled();
    await service.blockReference('CATEGORY', 'c1');
    expect(repo.lockReferenceExclusive).toHaveBeenCalledWith(expect.anything(), 'CATEGORY', 'c1');
    expect(repo.block).toHaveBeenCalledWith(expect.anything(), 'CATEGORY', 'c1');
  });
});
