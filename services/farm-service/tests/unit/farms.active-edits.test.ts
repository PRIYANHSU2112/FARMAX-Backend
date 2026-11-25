import type { Tx } from '@farmx/database';
import type { EventEnvelope } from '@farmx/infra/events';
import { describe, expect, it, vi } from 'vitest';

import type { Actor } from '../../src/features/audit/index.js';
import { createFarmEventHandlers } from '../../src/features/farms/farms.events.js';
import { FarmsService } from '../../src/features/farms/farms.service.js';
import type { FarmView } from '../../src/features/farms/farms.types.js';
import type { PinView } from '../../src/features/geo/geo.types.js';
import { KycService } from '../../src/features/kyc/kyc.service.js';

/**
 * Customer edits on ACTIVE farms (Farm Profile / Farm Location / Documents screens) and the
 * account-profile sync, over in-memory fakes (SQL is covered by the DB tests).
 */

const USER = '00000000-0000-7000-8000-0000000000u1';
const FARM = '00000000-0000-7000-8000-0000000000f1';
const NODE = '00000000-0000-7000-8000-0000000000n1';
const NODE2 = '00000000-0000-7000-8000-0000000000n2';
const actor: Actor = { userId: USER, ip: '127.0.0.1', requestId: 'req-1' };

const activeFarm = (): FarmView => ({
  id: FARM,
  farmCode: 'FX-WG-L-00418',
  farmCodePreview: 'FX-WG-L-00418',
  category: 'POULTRY_FARM',
  productionTypes: ['LAYER'],
  name: 'Sri Lakshmi Poultry',
  status: 'ACTIVE',
  statusReason: null,
  registrationStep: 5,
  owner: {
    id: 'owner-1',
    userId: USER,
    fullName: 'K. Venkata Ramana',
    phone: '+919849021746',
    ageBand: null,
    panMasked: 'AKLPK****Q',
    aadhaarLast4: '4417',
    kycStatus: 'VERIFIED',
    personalizedOffers: false,
    panVerified: true,
    aadhaarVerified: true,
  },
  capacities: [
    { productionType: 'LAYER', metric: 'BIRDS', value: 60000, period: 'STANDING', rank: 1 },
  ],
  totalBirdCapacity: 60000,
  location: {
    latitude: 16.7421,
    longitude: 81.1032,
    gpsAccuracyM: 6,
    capturedAt: '2026-10-04T04:46:00.000Z',
    addressLine: null,
    village: 'Denduluru',
    pinCode: '534432',
    territoryCode: 'WG',
    districtName: 'Eluru',
    mandalName: 'Denduluru',
    primaryNodeId: NODE,
    backupNodeId: NODE2,
    primaryNodeName: null,
    backupNodeName: null,
    deliveryPromise: null,
  },
  billing: {
    gstin: null,
    invoiceNameSource: 'FARM_NAME',
    invoiceName: null,
    gstVerified: false,
    businessName: null,
    tradeName: null,
    gstVerifiedAt: null,
    invoiceNameReview: null,
  },
  kycDeferred: false,
  channel: 'SELF',
  createdByUserId: USER,
  mergedIntoFarmId: null,
  submittedAt: null,
  activatedAt: '2026-10-04T05:00:00.000Z',
  version: 3,
  createdAt: '2026-10-04T04:00:00.000Z',
  updatedAt: '2026-10-04T05:00:00.000Z',
});

const pin = (overrides: Partial<PinView> = {}): PinView => ({
  pinCode: '534432',
  serviceable: true,
  territory: { id: 't-wg', code: 'WG' },
  districtName: 'Eluru',
  mandalName: 'Denduluru',
  villages: ['Denduluru'],
  primaryNode: { id: NODE, name: 'Mother WH (Eluru)' },
  backupNode: { id: NODE2, name: 'Tanuku C&F' },
  deliveryPromise: 'Next-day delivery here',
  ...overrides,
});

function setup(farm: FarmView = activeFarm(), pinRow: PinView = pin()) {
  let row = farm;
  const tx = {} as Tx;
  const outboxAdds: { type: string; data: unknown }[] = [];
  const farmsRepository = {
    findView: vi.fn(() => Promise.resolve(row)),
    update: vi.fn((_tx: Tx, _id: string, _v: number, patch: Partial<FarmView>) => {
      row = { ...row, ...patch, version: row.version + 1 };
      return Promise.resolve();
    }),
    replaceCapacities: vi.fn(() => Promise.resolve()),
    syncOwnerContact: vi.fn(() => Promise.resolve()),
    farmIdsOfUser: vi.fn(() => Promise.resolve([FARM])),
  };
  const geoService = {
    resolveServiceablePin: vi.fn(() => Promise.resolve(pinRow)),
    lookupPin: vi.fn(() => Promise.resolve(pin())),
    listTerritories: vi.fn(() => Promise.resolve([{ code: 'WG', stateCode: '37' }])),
  };
  const cache = {
    getOrSet: vi.fn((_k: string, _t: number, load: () => Promise<unknown>) => load()),
    invalidate: vi.fn(() => Promise.resolve()),
  };
  const outbox = {
    add: vi.fn((_tx: Tx, type: string, data: unknown) => {
      outboxAdds.push({ type, data });
      return Promise.resolve();
    }),
  };
  const deps = {
    farmsRepository,
    geoService,
    cache,
    outbox,
    auditService: { record: vi.fn() },
    runInTransaction: (work: (t: Tx) => Promise<unknown>) => work(tx),
    config: {},
    pii: {},
    logger: { warn: vi.fn() },
    reviewService: {},
  };
  const service = new FarmsService(
    deps as unknown as ConstructorParameters<typeof FarmsService>[0],
  );
  return { service, farmsRepository, geoService, cache, outboxAdds };
}

describe('Farm Profile: production types on an ACTIVE farm', () => {
  it('adds BROILER as a secondary type with its capacity', async () => {
    const { service, farmsRepository } = setup();
    const view = await service.updateActive(actor, FARM, 3, {
      productionTypes: ['LAYER', 'BROILER'],
      capacities: [
        { productionType: 'LAYER', metric: 'BIRDS', value: 60000, period: 'STANDING' },
        { productionType: 'BROILER', metric: 'BIRDS', value: 12000, period: 'PER_CYCLE' },
      ],
    });
    expect(farmsRepository.replaceCapacities).toHaveBeenCalledWith(
      expect.anything(),
      FARM,
      ['LAYER', 'BROILER'],
      expect.any(Array),
    );
    expect(view.productionTypes).toEqual(['LAYER', 'BROILER']);
    expect(view.totalBirdCapacity).toBe(72000);
  });

  it('409 PRIMARY_TYPE_LOCKED when the primary type changes', async () => {
    const { service, farmsRepository } = setup();
    await expect(
      service.updateActive(actor, FARM, 3, {
        productionTypes: ['BROILER', 'LAYER'],
        capacities: [
          { productionType: 'BROILER', metric: 'BIRDS', value: 12000, period: 'PER_CYCLE' },
        ],
      }),
    ).rejects.toMatchObject({ details: { reason: 'PRIMARY_TYPE_LOCKED', primary: 'LAYER' } });
    expect(farmsRepository.replaceCapacities).not.toHaveBeenCalled();
  });
});

describe('Farm Location on an ACTIVE farm', () => {
  const input = {
    latitude: 16.75,
    longitude: 81.11,
    accuracyM: 6,
    capturedAt: '2026-10-04T04:46:00.000Z',
    village: 'Denduluru',
    pinCode: '534432',
    addressLine: 'Flat 402, Rose Garden Apts',
  };

  it('moves inside the same territory and emits farm.updated.v1', async () => {
    const { service, farmsRepository, outboxAdds } = setup();
    await service.setLocation(actor, FARM, 3, input);
    expect(farmsRepository.update).toHaveBeenCalledWith(
      expect.anything(),
      FARM,
      3,
      expect.objectContaining({
        addressLine: 'Flat 402, Rose Garden Apts',
        pinCode: '534432',
        territoryCode: 'WG',
        latitude: 16.75,
      }),
    );
    expect(outboxAdds.map((e) => e.type)).toContain('farm.updated.v1');
  });

  it('409 TERRITORY_LOCKED for a pin in another territory', async () => {
    const { service, farmsRepository } = setup(
      activeFarm(),
      pin({ territory: { id: 't-eg', code: 'EG' } }),
    );
    await expect(service.setLocation(actor, FARM, 3, input)).rejects.toMatchObject({
      details: { reason: 'TERRITORY_LOCKED', currentTerritory: 'WG', newTerritory: 'EG' },
    });
    expect(farmsRepository.update).not.toHaveBeenCalled();
  });
});

describe('Farm Location card: serving nodes + delivery promise', () => {
  it('names the nodes the farm is stored against', async () => {
    const { service } = setup();
    const view = await service.getOwned(USER, FARM);
    expect(view.location).toMatchObject({
      primaryNodeName: 'Mother WH (Eluru)',
      backupNodeName: 'Tanuku C&F',
      deliveryPromise: 'Next-day delivery here',
    });
  });

  it('leaves a name null when the pin now points at another node', async () => {
    const farm = activeFarm();
    const { service } = setup({
      ...farm,
      location: farm.location === null ? null : { ...farm.location, backupNodeId: 'old-node' },
    });
    const view = await service.getOwned(USER, FARM);
    expect(view.location?.primaryNodeName).toBe('Mother WH (Eluru)');
    expect(view.location?.backupNodeName).toBeNull();
  });
});

describe('Documents: PAN lock', () => {
  it('409 PAN_LOCKED once the PAN card was accepted', async () => {
    const farm = activeFarm();
    const kyc = new KycService({
      farmsService: {
        ownedContext: () => Promise.resolve({ farm, ownerId: 'owner-1', ownerUserId: USER }),
      },
    } as unknown as ConstructorParameters<typeof KycService>[0]);
    await expect(kyc.setPan(actor, FARM, 'AKLPK7741Q')).rejects.toMatchObject({
      details: { reason: 'PAN_LOCKED' },
    });
  });
});

describe('user.profile_updated.v1 → owner snapshot', () => {
  const event = (data: Record<string, unknown>) =>
    ({ id: 'e-1', type: 'user.profile_updated.v1', data }) as unknown as EventEnvelope;

  it('syncs name + phone, then drops caches after commit', async () => {
    const { service, farmsRepository, cache } = setup();
    const handlers = createFarmEventHandlers({ farmsService: service });
    const e = event({
      userId: USER,
      fullName: 'Venkatesh Ramana',
      phone: '+919876543210',
      changedFields: ['fullName', 'phone'],
    });
    await handlers.inTx['user.profile_updated.v1']?.(e, {} as Tx);
    expect(farmsRepository.syncOwnerContact).toHaveBeenCalledWith(expect.anything(), USER, {
      fullName: 'Venkatesh Ramana',
      phone: '+919876543210',
    });
    await handlers.afterCommit['user.profile_updated.v1']?.(e);
    expect(cache.invalidate).toHaveBeenCalled();
  });

  it('never wipes the registered owner name with a blank account name', async () => {
    const { service, farmsRepository } = setup();
    const handlers = createFarmEventHandlers({ farmsService: service });
    await handlers.inTx['user.profile_updated.v1']?.(
      event({ userId: USER, fullName: '', phone: '+919876543210', changedFields: ['phone'] }),
      {} as Tx,
    );
    expect(farmsRepository.syncOwnerContact).toHaveBeenCalledWith(expect.anything(), USER, {
      phone: '+919876543210',
    });
  });

  it('ignores email / photo-only changes', async () => {
    const { service, farmsRepository } = setup();
    const handlers = createFarmEventHandlers({ farmsService: service });
    await handlers.inTx['user.profile_updated.v1']?.(
      event({ userId: USER, fullName: 'X', phone: null, changedFields: ['email', 'avatarUrl'] }),
      {} as Tx,
    );
    expect(farmsRepository.syncOwnerContact).not.toHaveBeenCalled();
  });
});

describe('Documents: "Keep farm name & send for review"', () => {
  const verification = {
    id: 'v-1',
    gstin: '37AKLPK7741Q1Z5',
    requestedBy: USER,
    portalStatus: 'ACTIVE',
    checkedAt: new Date(),
    legalName: 'K. Venkata Ramana',
    tradeName: 'Sri Lakshmi Agro Farms',
    stateCode: '37',
  };

  function kycSetup(farm: FarmView = activeFarm()) {
    const patches: Record<string, unknown>[] = [];
    const record = vi.fn(() => Promise.resolve());
    const kyc = new KycService({
      farmsService: {
        ownedContext: () => Promise.resolve({ farm, ownerId: 'owner-1', ownerUserId: USER }),
        territoryStateCode: () => Promise.resolve('37'),
        patchInTx: (_tx: Tx, _farm: unknown, patch: Record<string, unknown>) => {
          patches.push(patch);
          return Promise.resolve();
        },
        invalidate: () => Promise.resolve(),
        getOwned: () => Promise.resolve(farm),
      },
      kycRepository: { findGstVerification: () => Promise.resolve(verification) },
      auditService: { record },
      runInTransaction: (work: (t: Tx) => Promise<unknown>) => work({} as Tx),
    } as unknown as ConstructorParameters<typeof KycService>[0]);
    return { kyc, patches, record };
  }

  it('different GST name + FARM_NAME → PENDING review; invoices stay on the GST trade name', async () => {
    const { kyc, patches, record } = kycSetup();
    await kyc.setBilling(actor, FARM, { verificationId: 'v-1', invoiceNameSource: 'FARM_NAME' });
    expect(patches[0]).toMatchObject({
      invoiceNameSource: 'GST_TRADE_NAME',
      invoiceName: 'Sri Lakshmi Agro Farms',
      invoiceNameReview: 'PENDING',
    });
    expect(patches[0]?.invoiceNameRequestedAt).toBeInstanceOf(Date);
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({ action: 'farm.invoice_name_review_requested' }),
    );
  });

  it('same name → FARM_NAME at once, no review', async () => {
    const { kyc, patches, record } = kycSetup({ ...activeFarm(), name: 'Sri Lakshmi Agro-Farms' });
    await kyc.setBilling(actor, FARM, { verificationId: 'v-1', invoiceNameSource: 'FARM_NAME' });
    expect(patches[0]).toMatchObject({
      invoiceNameSource: 'FARM_NAME',
      invoiceName: 'Sri Lakshmi Agro-Farms',
      invoiceNameReview: null,
    });
    expect(record).not.toHaveBeenCalled();
  });

  it('GST_TRADE_NAME withdraws a pending request', async () => {
    const farm = activeFarm();
    const { kyc, patches } = kycSetup({
      ...farm,
      billing: {
        ...farm.billing,
        invoiceNameReview: {
          status: 'PENDING',
          requestedAt: '2026-11-24T05:00:00.000Z',
          reviewedAt: null,
          note: null,
        },
      },
    });
    await kyc.setBilling(actor, FARM, {
      verificationId: 'v-1',
      invoiceNameSource: 'GST_TRADE_NAME',
    });
    expect(patches[0]).toMatchObject({
      invoiceNameSource: 'GST_TRADE_NAME',
      invoiceNameReview: null,
      invoiceNameRequestedAt: null,
    });
  });
});

describe('Admin: invoice-name review decision', () => {
  const ADMIN: Actor = {
    userId: '00000000-0000-7000-8000-0000000000a1',
    ip: '127.0.0.1',
    requestId: 'req-a',
  };
  const pending = (): FarmView => {
    const farm = activeFarm();
    return {
      ...farm,
      billing: {
        ...farm.billing,
        gstin: '37AKLPK7741Q1Z5',
        invoiceNameSource: 'GST_TRADE_NAME',
        invoiceName: 'Sri Lakshmi Agro Farms',
        invoiceNameReview: {
          status: 'PENDING',
          requestedAt: '2026-11-24T05:00:00.000Z',
          reviewedAt: null,
          note: null,
        },
      },
    };
  };
  const REASON = 'Farm name is the registered brand of the GSTIN holder';

  it('approve → invoices switch to the farm name', async () => {
    const { service, farmsRepository } = setup(pending());
    await service.decideInvoiceName(ADMIN, FARM, 'approve', REASON, undefined);
    expect(farmsRepository.update).toHaveBeenCalledWith(
      expect.anything(),
      FARM,
      3,
      expect.objectContaining({
        invoiceNameSource: 'FARM_NAME',
        invoiceName: 'Sri Lakshmi Poultry',
        invoiceNameReview: 'APPROVED',
        invoiceNameReviewedById: ADMIN.userId,
        invoiceNameReviewNote: REASON,
      }),
    );
  });

  it('reject → stays on the GST trade name, reason kept for the owner', async () => {
    const { service, farmsRepository } = setup(pending());
    await service.decideInvoiceName(ADMIN, FARM, 'reject', REASON, undefined);
    const patch = farmsRepository.update.mock.calls[0]?.[3];
    expect(patch).toMatchObject({ invoiceNameReview: 'REJECTED', invoiceNameReviewNote: REASON });
    expect(patch).not.toHaveProperty('invoiceNameSource');
  });

  it('409 NO_PENDING_REVIEW when nothing is pending', async () => {
    const { service } = setup();
    await expect(
      service.decideInvoiceName(ADMIN, FARM, 'approve', REASON, undefined),
    ).rejects.toMatchObject({ details: { reason: 'NO_PENDING_REVIEW' } });
  });

  it('403 SOD_VIOLATION for the farm owner / registrar', async () => {
    const { service } = setup(pending());
    await expect(
      service.decideInvoiceName(actor, FARM, 'approve', REASON, undefined),
    ).rejects.toMatchObject({ details: { reason: 'SOD_VIOLATION' } });
  });
});
