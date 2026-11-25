import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import {
  AUTH_ADMIN,
  AUTH_CUSTOMER,
  AUTH_PUBLIC,
  ERR,
  ETAG,
  IDEMPOTENCY_KEY,
  IDS,
  IF_MATCH,
  ok,
  reasonIssue,
} from '../../docs/shared.js';
import {
  CATEGORIES,
  KYC_STATUSES,
  METRICS,
  PERIODS,
  PRODUCTION_TYPES,
  STATUSES,
} from './farms.validation.js';

export const FARMS_TAG = 'Farms · Registration';
export const ADMIN_FARMS_TAG = 'Admin · Farms';

const uuid = Joi.string().guid();
const isoDate = Joi.date().iso();

const capacity = Joi.object({
  productionType: Joi.string().valid(...PRODUCTION_TYPES),
  metric: Joi.string().valid(...METRICS),
  value: Joi.number().example(60000),
  period: Joi.string()
    .valid(...PERIODS)
    .example('STANDING'),
  rank: Joi.number().integer().description('1 = primary production type').example(1),
}).meta({ className: 'FarmCapacity' });

const owner = Joi.object({
  id: uuid,
  userId: uuid,
  fullName: Joi.string().example('Kothapalli Venkata Ramana'),
  phone: Joi.string().allow(null).example('+919876543210'),
  ageBand: Joi.string()
    .valid('AGE_18_30', 'AGE_31_45', 'AGE_46_60', 'AGE_60_PLUS')
    .allow(null)
    .example('AGE_46_60'),
  panMasked: Joi.string().allow(null).example('AKLPK****Q'),
  aadhaarLast4: Joi.string().allow(null).example('4417'),
  kycStatus: Joi.string().valid(...KYC_STATUSES),
  personalizedOffers: Joi.boolean(),
  panVerified: Joi.boolean().description('PAN card accepted: PAN is locked (409 PAN_LOCKED)'),
  aadhaarVerified: Joi.boolean().description('Aadhaar e-KYC passed'),
}).meta({ className: 'FarmOwner' });

const location = Joi.object({
  latitude: Joi.number().allow(null).example(16.7421),
  longitude: Joi.number().allow(null).example(81.1032),
  gpsAccuracyM: Joi.number().allow(null).example(6),
  capturedAt: isoDate.allow(null),
  addressLine: Joi.string().allow(null),
  village: Joi.string().allow(null).example('Denduluru'),
  pinCode: Joi.string().allow(null).example('534432'),
  territoryCode: Joi.string().allow(null).example('WG'),
  districtName: Joi.string().allow(null).example('Eluru'),
  mandalName: Joi.string().allow(null).example('Denduluru'),
  primaryNodeId: uuid.allow(null),
  backupNodeId: uuid.allow(null),
  primaryNodeName: Joi.string().allow(null).example('Mother WH (Eluru)'),
  backupNodeName: Joi.string().allow(null).example('Tanuku C&F'),
  deliveryPromise: Joi.string().allow(null).example('Next-day delivery here'),
})
  .allow(null)
  .description('null until step 3 (location) is saved')
  .meta({ className: 'FarmLocation' });

/** Full farm view (customer detail, admin detail, write responses). PII masked. */
export const farmSchema = Joi.object({
  id: uuid,
  farmCode: Joi.string()
    .allow(null)
    .description('Permanent Farm ID; null until the farm is ACTIVE')
    .example('FX-WG-L-00418'),
  farmCodePreview: Joi.string()
    .allow(null)
    .description('Shape of the future Farm ID once territory + primary type are known')
    .example('FX-WG-L-•••••'),
  category: Joi.string().valid(...CATEGORIES),
  productionTypes: Joi.array()
    .items(Joi.string().valid(...PRODUCTION_TYPES))
    .description('Ranked; the first one is the primary type'),
  name: Joi.string().description('Empty string until step 2').example('Sri Lakshmi Poultry'),
  status: Joi.string().valid(...STATUSES),
  statusReason: Joi.string().allow(null),
  registrationStep: Joi.number().integer().min(1).max(5).example(3),
  owner,
  capacities: Joi.array().items(capacity),
  totalBirdCapacity: Joi.number().integer().allow(null).example(72000),
  location,
  billing: Joi.object({
    gstin: Joi.string().allow(null).example('37AKLPK7741Q1Z5'),
    invoiceNameSource: Joi.string().valid('FARM_NAME', 'GST_TRADE_NAME'),
    invoiceName: Joi.string().allow(null),
    gstVerified: Joi.boolean().description(
      'true = GSTIN bound from an ACTIVE portal check (B2B / ITC billing)',
    ),
    businessName: Joi.string().allow(null).description('GST "Legal Name of Business"'),
    tradeName: Joi.string().allow(null),
    gstVerifiedAt: Joi.date().iso().allow(null),
    invoiceNameReview: Joi.object({
      status: Joi.string().valid('PENDING', 'APPROVED', 'REJECTED'),
      requestedAt: Joi.date().iso().allow(null),
      reviewedAt: Joi.date().iso().allow(null),
      note: Joi.string().allow(null).description('Staff reason (show it on REJECTED)'),
    })
      .allow(null)
      .description(
        '"Keep farm name & send for review". null = never asked. PENDING / REJECTED: invoices use the GST trade name; APPROVED: the farm name.',
      )
      .meta({ className: 'InvoiceNameReview' }),
  }),
  kycDeferred: Joi.boolean(),
  channel: Joi.string().valid('SELF', 'FIELD_ASSISTED', 'ADMIN', 'IMPORT').example('SELF'),
  createdByUserId: uuid,
  mergedIntoFarmId: uuid.allow(null),
  submittedAt: isoDate.allow(null),
  activatedAt: isoDate.allow(null),
  version: Joi.number().integer().description('Send back as If-Match on writes').example(4),
  createdAt: isoDate,
  updatedAt: isoDate,
}).meta({ className: 'Farm' });

const NOW = '2026-11-12T09:30:00.000Z';

/** A complete ACTIVE farm, reused by every farm-returning example. */
export const farmExample = {
  id: IDS.farm,
  farmCode: 'FX-WG-L-00418',
  farmCodePreview: 'FX-WG-L-•••••',
  category: 'POULTRY_FARM',
  productionTypes: ['LAYER', 'BROILER'],
  name: 'Sri Lakshmi Poultry',
  status: 'ACTIVE',
  statusReason: null,
  registrationStep: 5,
  owner: {
    id: IDS.owner,
    userId: IDS.user,
    fullName: 'Kothapalli Venkata Ramana',
    phone: '+919876543210',
    ageBand: 'AGE_46_60',
    panMasked: 'AKLPK****Q',
    aadhaarLast4: '4417',
    kycStatus: 'VERIFIED',
    personalizedOffers: true,
    panVerified: true,
    aadhaarVerified: true,
  },
  capacities: [
    { productionType: 'LAYER', metric: 'BIRDS', value: 60000, period: 'STANDING', rank: 1 },
    { productionType: 'BROILER', metric: 'BIRDS', value: 12000, period: 'PER_CYCLE', rank: 2 },
  ],
  totalBirdCapacity: 72000,
  location: {
    latitude: 16.7421,
    longitude: 81.1032,
    gpsAccuracyM: 6,
    capturedAt: '2026-11-10T06:12:00.000Z',
    addressLine: 'Near ZP High School, Main Road',
    village: 'Denduluru',
    pinCode: '534432',
    territoryCode: 'WG',
    districtName: 'Eluru',
    mandalName: 'Denduluru',
    primaryNodeId: IDS.node,
    backupNodeId: IDS.node2,
    primaryNodeName: 'Mother WH (Eluru)',
    backupNodeName: 'Tanuku C&F',
    deliveryPromise: 'Next-day delivery here',
  },
  billing: {
    gstin: '37AKLPK7741Q1Z5',
    invoiceNameSource: 'GST_TRADE_NAME',
    invoiceName: 'Sri Lakshmi Agro Farms',
    gstVerified: true,
    businessName: 'K. Venkata Ramana',
    tradeName: 'Sri Lakshmi Agro Farms',
    gstVerifiedAt: '2026-11-10T09:12:00.000Z',
    invoiceNameReview: null,
  },
  kycDeferred: false,
  channel: 'SELF',
  createdByUserId: IDS.user,
  mergedIntoFarmId: null,
  submittedAt: NOW,
  activatedAt: NOW,
  version: 4,
  createdAt: '2026-11-10T06:00:00.000Z',
  updatedAt: NOW,
};

const draftExample = {
  ...farmExample,
  farmCode: null,
  farmCodePreview: null,
  productionTypes: [],
  name: '',
  status: 'DRAFT',
  registrationStep: 1,
  owner: {
    ...farmExample.owner,
    fullName: '',
    ageBand: null,
    panMasked: null,
    aadhaarLast4: null,
    kycStatus: 'NOT_STARTED',
    personalizedOffers: false,
  },
  capacities: [],
  totalBirdCapacity: null,
  location: null,
  billing: {
    gstin: null,
    invoiceNameSource: 'FARM_NAME',
    invoiceName: null,
    gstVerified: false,
    businessName: null,
    tradeName: null,
    gstVerifiedAt: null,
  },
  submittedAt: null,
  activatedAt: null,
  version: 0,
  createdAt: NOW,
};

const inDraft = (patch: Record<string, unknown>) => ({
  ...farmExample,
  farmCode: null,
  status: 'DRAFT',
  submittedAt: null,
  activatedAt: null,
  ...patch,
});

const summarySchema = Joi.object({
  id: uuid,
  farmCode: Joi.string().allow(null),
  name: Joi.string(),
  category: Joi.string().valid(...CATEGORIES),
  productionTypes: Joi.array().items(Joi.string().valid(...PRODUCTION_TYPES)),
  status: Joi.string().valid(...STATUSES),
  registrationStep: Joi.number().integer(),
  village: Joi.string().allow(null),
  pinCode: Joi.string().allow(null),
  totalBirdCapacity: Joi.number().integer().allow(null),
  createdAt: isoDate,
}).meta({ className: 'FarmSummary' });

const summaryExample = {
  id: IDS.farm,
  farmCode: 'FX-WG-L-00418',
  name: 'Sri Lakshmi Poultry',
  category: 'POULTRY_FARM',
  productionTypes: ['LAYER', 'BROILER'],
  status: 'ACTIVE',
  registrationStep: 5,
  village: 'Denduluru',
  pinCode: '534432',
  totalBirdCapacity: 72000,
  createdAt: '2026-11-10T06:00:00.000Z',
};

const adminListItem = summarySchema
  .keys({
    ownerId: uuid,
    ownerName: Joi.string(),
    ownerPhone: Joi.string().allow(null),
    territoryCode: Joi.string().allow(null),
    kycStatus: Joi.string().valid(...KYC_STATUSES),
    submittedAt: isoDate.allow(null),
    invoiceNameReview: Joi.string().valid('PENDING', 'APPROVED', 'REJECTED').allow(null),
  })
  .meta({ className: 'AdminFarmListItem' });

const statusEvent = Joi.object({
  fromStatus: Joi.string()
    .valid(...STATUSES)
    .allow(null),
  toStatus: Joi.string().valid(...STATUSES),
  reason: Joi.string().allow(null),
  actorType: Joi.string().valid('OWNER', 'ADMIN', 'SYSTEM'),
  createdAt: isoDate,
}).meta({ className: 'FarmStatusEvent' });

const adminFarmSchema = farmSchema
  .keys({
    statusHistory: Joi.array()
      .items(statusEvent)
      .description('Last 20 status changes, newest first'),
  })
  .meta({ className: 'AdminFarm' });

const passSchema = Joi.object({
  farmCode: Joi.string().example('FX-WG-L-00418'),
  name: Joi.string().example('Sri Lakshmi Poultry'),
  ownerName: Joi.string(),
  locationLabel: Joi.string().example('Denduluru, Eluru, 534432'),
  productionSummary: Joi.string().example('Layer, Broiler · 72,000 birds'),
  totalBirdCapacity: Joi.number().integer().allow(null),
  memberSince: isoDate.description('activatedAt'),
  qr: Joi.object({
    payload: Joi.string().example('FX1:FX-WG-L-00418'),
    signature: Joi.string()
      .hex()
      .length(64)
      .description('Pass to GET /farms/verify/{farmCode}?sig='),
  }),
  shareText: Joi.string(),
}).meta({ className: 'FarmPass' });

const submitResult = Joi.object({
  farm: farmSchema,
  caseId: uuid.allow(null).description('Duplicate-review case id when status is UNDER_REVIEW'),
}).meta({ className: 'FarmSubmitResult' });

const categorySchema = Joi.object({
  category: Joi.string().valid(...CATEGORIES),
  title: Joi.string(),
  subtitle: Joi.string(),
  productionTypes: Joi.array().items(
    Joi.object({
      type: Joi.string().valid(...PRODUCTION_TYPES),
      typeCode: Joi.string().description('Farm ID type segment').example('L'),
    }),
  ),
  capacityFields: Joi.array().items(
    Joi.object({
      metric: Joi.string().valid(...METRICS),
      periods: Joi.array().items(Joi.string().valid(...PERIODS)),
      required: Joi.boolean(),
      unit: Joi.string().example('birds'),
    }),
  ),
  requiredDocs: Joi.array().items(Joi.string().valid('AADHAAR', 'PAN', 'GSTIN')),
  kycRequired: Joi.boolean(),
}).meta({ className: 'FarmCategory' });

const verifySchema = Joi.object({
  farmCode: Joi.string().example('FX-WG-L-00418'),
  name: Joi.string().example('Sri Lakshmi Poultry'),
  status: Joi.string().valid(...STATUSES),
  territoryCode: Joi.string().allow(null).example('WG'),
}).meta({ className: 'FarmPassCheck' });

const statsSchema = Joi.object({
  total: Joi.number().integer(),
  byStatus: Joi.object().pattern(Joi.string(), Joi.number().integer()),
  byCategory: Joi.object().pattern(Joi.string(), Joi.number().integer()),
  generatedAt: isoDate,
}).meta({ className: 'FarmStats' });

const auditRow = Joi.object({
  id: uuid,
  actorUserId: uuid,
  action: Joi.string().example('farm.suspend'),
  reason: Joi.string().allow(null),
  createdAt: isoDate,
}).meta({ className: 'FarmAuditRow' });

const CACHED = 'Cache-first read (Redis, 5 min TTL, invalidated on every write).';
const page = (limit = 20) => ({ nextCursor: null, limit });
const farm = (status: 200 | 201, description: string, example: unknown = farmExample) => ({
  status,
  description,
  data: farmSchema,
  example: ok(example),
  headers: ETAG,
});
const capacitiesIssue = {
  summary: 'Capacity not valid for the category',
  message: 'Validation failed',
  details: {
    issues: [{ path: 'capacities.0', message: 'EGGS/STANDING is not valid for POULTRY_FARM' }],
  },
};

export const FARMS_DOCS = {
  categories: {
    tag: FARMS_TAG,
    operationId: 'listFarmCategories',
    summary: 'Registration categories (step 1)',
    description:
      'Static rules for the "What do you run?" screen: production types (with their Farm ID type code), capacity fields per metric and the documents each category needs.',
    auth: AUTH_CUSTOMER,
    success: {
      status: 200,
      description: 'Categories in display order',
      data: Joi.array().items(categorySchema),
      headers: {
        'Cache-Control': {
          description: 'Static data: `public, max-age=3600`.',
          schema: { type: 'string', example: 'public, max-age=3600' },
        },
      },
      example: ok([
        {
          category: 'POULTRY_FARM',
          title: 'Poultry farm',
          subtitle: 'Layer, broiler or breeder birds',
          productionTypes: [
            { type: 'LAYER', typeCode: 'L' },
            { type: 'BROILER', typeCode: 'B' },
            { type: 'BROILER_BREEDER', typeCode: 'BB' },
            { type: 'LAYER_BREEDER', typeCode: 'LB' },
          ],
          capacityFields: [
            { metric: 'BIRDS', periods: ['STANDING', 'PER_CYCLE'], required: true, unit: 'birds' },
          ],
          requiredDocs: ['AADHAAR', 'PAN', 'GSTIN'],
          kycRequired: true,
        },
        {
          category: 'BACKYARD',
          title: 'Backyard or small buyer',
          subtitle: 'Mobile and address only · no GST',
          productionTypes: [{ type: 'BACKYARD', typeCode: 'R' }],
          capacityFields: [
            { metric: 'BIRDS', periods: ['STANDING', 'PER_CYCLE'], required: false, unit: 'birds' },
          ],
          requiredDocs: [],
          kycRequired: false,
        },
      ]),
    },
  },
  list: {
    tag: FARMS_TAG,
    operationId: 'listMyFarms',
    summary: 'My farms',
    description: `Newest first, keyset pagination (\`cursor\` = last farm id). ${CACHED}`,
    auth: AUTH_CUSTOMER,
    success: {
      status: 200,
      description: 'A page of the caller’s farms',
      data: summarySchema,
      paginated: true,
      example: ok([summaryExample], page()),
    },
    errors: [422],
  },
  get: {
    tag: FARMS_TAG,
    operationId: 'getMyFarm',
    summary: 'Get my farm',
    description: CACHED,
    auth: AUTH_CUSTOMER,
    success: farm(200, 'The farm'),
    errors: [404, 422],
    errorExamples: { 404: ERR.farmNotFound, 422: ERR.badId },
  },
  createDraft: {
    tag: FARMS_TAG,
    operationId: 'createFarmDraft',
    summary: 'Start a registration (step 1)',
    description:
      'Creates a DRAFT for a business category. Single-type categories (HATCHERY, FEED_MILL) get their production type set automatically. `BACKYARD` → 422 (use `POST /farms/quick`). At most `MAX_OPEN_DRAFTS` (default 3) open drafts per owner, else 409 `DRAFT_LIMIT_REACHED`.',
    auth: AUTH_CUSTOMER,
    rateLimit: '10 per user per 24 h',
    headers: IDEMPOTENCY_KEY,
    requestExample: { category: 'POULTRY_FARM' },
    success: {
      status: 201,
      description: 'Draft created (`version` 0)',
      data: farmSchema,
      example: ok(draftExample),
    },
    errors: [409, 422],
    errorExamples: {
      409: [
        {
          summary: 'DRAFT_LIMIT_REACHED',
          message: 'Finish or discard an open registration first',
          details: { reason: 'DRAFT_LIMIT_REACHED' },
        },
        ERR.idempotencyBusy,
      ],
      422: {
        summary: 'Backyard category',
        message: 'Validation failed',
        details: {
          issues: [{ path: 'category', message: 'use POST /farms/quick for backyard buyers' }],
        },
      },
    },
  },
  quick: {
    tag: FARMS_TAG,
    operationId: 'quickSignupBackyard',
    summary: 'Backyard quick sign-up',
    description:
      'Mobile + address only: creates a BACKYARD farm and activates it immediately with a Farm ID (no KYC, no duplicate review). `latitude` and `longitude` go together. The pin code must be serviceable.',
    auth: AUTH_CUSTOMER,
    rateLimit: '5 per user per 24 h',
    headers: IDEMPOTENCY_KEY,
    requestExample: {
      ownerName: 'Pothula Lakshmi',
      addressLine: '2-14, Church Street',
      village: 'Kovvali',
      pinCode: '534432',
      latitude: 16.7302,
      longitude: 81.1187,
      accuracyM: 12,
      birds: 40,
      personalizedOffers: false,
    },
    success: {
      status: 201,
      description: 'Active backyard farm with its Farm ID',
      data: farmSchema,
      example: ok({
        ...farmExample,
        farmCode: 'FX-WG-R-00073',
        category: 'BACKYARD',
        productionTypes: ['BACKYARD'],
        name: 'Pothula Lakshmi',
        capacities: [
          { productionType: 'BACKYARD', metric: 'BIRDS', value: 40, period: 'STANDING', rank: 1 },
        ],
        totalBirdCapacity: 40,
        billing: {
          gstin: null,
          invoiceNameSource: 'FARM_NAME',
          invoiceName: null,
          gstVerified: false,
          businessName: null,
          tradeName: null,
          gstVerifiedAt: null,
        },
      }),
    },
    errors: [409, 422],
    errorExamples: { 409: ERR.idempotencyBusy, 422: ERR.pinNotServiceable },
  },
  details: {
    tag: FARMS_TAG,
    operationId: 'saveFarmDetails',
    summary: 'Farm details (step 2)',
    description:
      'Farm name, owner name, ranked production types (ignored for single-type categories) and at least one capacity per selected type. Capacities must match the category rules from `GET /farms/categories`. Allowed only in DRAFT or NEEDS_ATTENTION.',
    auth: AUTH_CUSTOMER,
    headers: IF_MATCH,
    requestExample: {
      name: 'Sri Lakshmi Poultry',
      ownerName: 'Kothapalli Venkata Ramana',
      productionTypes: ['LAYER', 'BROILER'],
      capacities: [
        { productionType: 'LAYER', metric: 'BIRDS', value: 60000, period: 'STANDING' },
        { productionType: 'BROILER', metric: 'BIRDS', value: 12000, period: 'PER_CYCLE' },
      ],
    },
    success: farm(200, 'Updated draft', inDraft({ registrationStep: 2, location: null })),
    errors: [404, 409, 422],
    errorExamples: {
      404: ERR.farmNotFound,
      409: [ERR.versionConflict, ERR.notEditable],
      422: capacitiesIssue,
    },
  },
  location: {
    tag: FARMS_TAG,
    operationId: 'saveFarmLocation',
    summary: 'Farm location (step 3)',
    description:
      'GPS fix (inside India, accuracy ≤ 100 m, `capturedAt` not in the future) + village + serviceable pin code. Territory, district, mandal and serving nodes are resolved server-side from the pin. Allowed in DRAFT or NEEDS_ATTENTION, and on ACTIVE farms (Farm Location screen) only inside the same territory: a pin in another territory → 409 `TERRITORY_LOCKED` (the Farm ID carries the territory code).',
    auth: AUTH_CUSTOMER,
    headers: IF_MATCH,
    requestExample: {
      latitude: 16.7421,
      longitude: 81.1032,
      accuracyM: 6,
      capturedAt: '2026-11-10T06:12:00.000Z',
      village: 'Denduluru',
      pinCode: '534432',
      addressLine: 'Near ZP High School, Main Road',
    },
    success: farm(200, 'Updated draft', inDraft({ registrationStep: 3 })),
    errors: [404, 409, 422],
    errorExamples: {
      404: ERR.farmNotFound,
      409: [
        ERR.versionConflict,
        ERR.notEditable,
        {
          summary: 'Other territory (ACTIVE farm)',
          message:
            'This pin code is in another territory. Your Farm ID is tied to its territory; contact support to move the farm.',
          details: { reason: 'TERRITORY_LOCKED', currentTerritory: 'WG', newTerritory: 'EG' },
        },
      ],
      422: [
        ERR.pinNotServiceable,
        {
          summary: 'GPS too inaccurate',
          message: 'Validation failed',
          details: {
            issues: [
              {
                path: 'body.accuracyM',
                message: 'GPS accuracy must be within 100 m; move to open sky and retry',
              },
            ],
          },
        },
      ],
    },
  },
  owner: {
    tag: FARMS_TAG,
    operationId: 'saveOwnerPreferences',
    summary: 'Owner preferences (step 5)',
    description:
      'Age band and personalised-offers consent (each consent change writes a DPDP consent-ledger row). At least one field. Allowed in any status; no `If-Match`, but a concurrent write still answers 409.',
    auth: AUTH_CUSTOMER,
    requestExample: { ageBand: 'AGE_46_60', personalizedOffers: true },
    success: farm(200, 'Updated farm', inDraft({ registrationStep: 5 })),
    errors: [404, 409, 422],
    errorExamples: { 404: ERR.farmNotFound, 409: ERR.versionConflict },
  },
  deferKyc: {
    tag: FARMS_TAG,
    operationId: 'deferFarmKyc',
    summary: 'Skip KYC and verify later',
    description:
      'Business categories may submit without KYC; GST invoicing and Rx stay gated until verified. A no-op for categories without KYC. Allowed only in DRAFT or NEEDS_ATTENTION. No body.',
    auth: AUTH_CUSTOMER,
    success: farm(
      200,
      'Updated farm (`kycDeferred: true`)',
      inDraft({ registrationStep: 4, kycDeferred: true }),
    ),
    errors: [404, 409, 422],
    errorExamples: { 404: ERR.farmNotFound, 409: [ERR.notEditable, ERR.versionConflict] },
  },
  discard: {
    tag: FARMS_TAG,
    operationId: 'discardFarmDraft',
    summary: 'Discard a draft',
    description: 'Soft-deletes a DRAFT. Any other status → 409.',
    auth: AUTH_CUSTOMER,
    success: { status: 204, description: 'Discarded (no body)' },
    errors: [404, 409, 422],
    errorExamples: {
      404: ERR.farmNotFound,
      409: {
        summary: 'Not a draft',
        message: 'Only drafts can be discarded',
        details: { reason: 'FARM_STATE_INVALID' },
      },
    },
  },
  submit: {
    tag: FARMS_TAG,
    operationId: 'submitFarm',
    summary: 'Submit / resubmit (Farm ID issued)',
    description:
      'Checks completeness (details, capacities, location, and KYC unless deferred for KYC categories; missing steps → 422 listing them), then runs the duplicate check. No match → ACTIVE with a permanent Farm ID; match → UNDER_REVIEW with a `caseId`. Allowed from DRAFT or NEEDS_ATTENTION. `acknowledgePermanentId` must be `true`.',
    auth: AUTH_CUSTOMER,
    rateLimit: '10 per user per 24 h',
    headers: { ...IF_MATCH, ...IDEMPOTENCY_KEY },
    requestExample: { acknowledgePermanentId: true },
    success: {
      status: 200,
      description: 'ACTIVE (`caseId: null`) or UNDER_REVIEW (`caseId` set)',
      data: submitResult,
      example: ok({ farm: farmExample, caseId: null }),
    },
    errors: [404, 409, 422],
    errorExamples: {
      404: ERR.farmNotFound,
      409: [ERR.versionConflict, ERR.notEditable, ERR.idempotencyBusy],
      422: {
        summary: 'Registration incomplete',
        message: 'Registration is incomplete',
        details: {
          issues: [
            { path: 'location', message: 'location step is incomplete' },
            { path: 'kyc', message: 'kyc step is incomplete' },
          ],
        },
      },
    },
  },
  pass: {
    tag: FARMS_TAG,
    operationId: 'getFarmPass',
    summary: 'Farm pass (Farm ID card + signed QR)',
    description: `Only once the Farm ID is issued (else 409). ${CACHED}`,
    auth: AUTH_CUSTOMER,
    success: {
      status: 200,
      description: 'Pass',
      data: passSchema,
      example: ok({
        farmCode: 'FX-WG-L-00418',
        name: 'Sri Lakshmi Poultry',
        ownerName: 'Kothapalli Venkata Ramana',
        locationLabel: 'Denduluru, Eluru, 534432',
        productionSummary: 'Layer, Broiler · 72,000 birds',
        totalBirdCapacity: 72000,
        memberSince: NOW,
        qr: {
          payload: 'FX1:FX-WG-L-00418',
          signature: '9f2c4e8a1b7d3f60c5a9e2d4b8f1a3c7e6d0b9a2f4c8e1d3b7a5f9c2e4d6b8a0',
        },
        shareText: 'My FarmX Farm ID is FX-WG-L-00418 (Sri Lakshmi Poultry).',
      }),
    },
    errors: [404, 409, 422],
    errorExamples: {
      404: ERR.farmNotFound,
      409: {
        summary: 'Farm ID not issued yet',
        message: 'The Farm ID is not issued yet',
        details: { reason: 'FARM_STATE_INVALID' },
      },
    },
  },
  updateActive: {
    tag: FARMS_TAG,
    operationId: 'updateActiveFarm',
    summary: 'Edit an active farm',
    description:
      'ACTIVE farms only (Farm Profile / Hatchery Profile screens): address line, production types and capacities. `productionTypes` (ranked) needs `capacities` (one per type, category rules apply); `productionTypes[0]` must stay the current primary type, which is in the Farm ID (else 409 `PRIMARY_TYPE_LOCKED`). Farm name is locked (admins correct it); the owner name follows the account name (`PATCH /v1/auth/me`). At least one field.',
    auth: AUTH_CUSTOMER,
    headers: IF_MATCH,
    requestExample: {
      addressLine: 'Opp. Panchayat Office, Main Road',
      productionTypes: ['LAYER', 'BROILER'],
      capacities: [
        { productionType: 'LAYER', metric: 'BIRDS', value: 65000, period: 'STANDING' },
        { productionType: 'BROILER', metric: 'BIRDS', value: 12000, period: 'PER_CYCLE' },
      ],
    },
    success: farm(200, 'Updated farm', { ...farmExample, totalBirdCapacity: 77000, version: 5 }),
    errors: [404, 409, 422],
    errorExamples: {
      404: ERR.farmNotFound,
      409: [
        ERR.versionConflict,
        {
          summary: 'Not ACTIVE',
          message: 'Only active farms can be edited here',
          details: { reason: 'FARM_STATE_INVALID' },
        },
        {
          summary: 'Primary type changed',
          message:
            'The primary production type (LAYER) is part of your Farm ID and cannot change; add or remove the others.',
          details: { reason: 'PRIMARY_TYPE_LOCKED', primary: 'LAYER' },
        },
      ],
      422: capacitiesIssue,
    },
  },
  verifyPass: {
    tag: FARMS_TAG,
    operationId: 'verifyFarmPass',
    summary: 'Verify a Farm-pass QR (public)',
    public: true,
    description:
      'For drivers and field staff scanning a Farm pass. `sig` is the QR `signature` (HMAC-SHA256, 64 hex). A wrong signature and an unknown Farm ID both answer 404. Minimal fields only.',
    auth: AUTH_PUBLIC,
    rateLimit: '30 per IP per minute',
    success: {
      status: 200,
      description: 'Farm summary',
      data: verifySchema,
      example: ok({
        farmCode: 'FX-WG-L-00418',
        name: 'Sri Lakshmi Poultry',
        status: 'ACTIVE',
        territoryCode: 'WG',
      }),
    },
    errors: [404, 422],
    errorExamples: { 404: ERR.farmNotFound },
  },

  // ── Admin ──
  adminList: {
    tag: ADMIN_FARMS_TAG,
    operationId: 'adminSearchFarms',
    summary: 'Search farms',
    description:
      '`q` = Farm ID prefix (FX-…), GSTIN, phone or partial name (trigram index). Filters combine with AND. `createdTo` must be after `createdFrom`. Keyset pagination (`cursor` = last farm id). PII masked.',
    auth: AUTH_ADMIN,
    permission: 'customers.view',
    success: {
      status: 200,
      description: 'A page of farms',
      data: adminListItem,
      paginated: true,
      example: ok(
        [
          {
            ...summaryExample,
            ownerId: IDS.owner,
            ownerName: 'Kothapalli Venkata Ramana',
            ownerPhone: '+919876543210',
            territoryCode: 'WG',
            kycStatus: 'VERIFIED',
            submittedAt: NOW,
            invoiceNameReview: null,
          },
        ],
        page(),
      ),
    },
    errors: [422],
  },
  adminStats: {
    tag: ADMIN_FARMS_TAG,
    operationId: 'adminFarmStats',
    summary: 'Farm counters',
    description: 'Totals by status and category. Cached 60 s.',
    auth: AUTH_ADMIN,
    permission: 'customers.view',
    success: {
      status: 200,
      description: 'Totals by status and category',
      data: statsSchema,
      example: ok({
        total: 1284,
        byStatus: {
          ACTIVE: 1102,
          DRAFT: 96,
          UNDER_REVIEW: 14,
          NEEDS_ATTENTION: 9,
          SUSPENDED: 3,
          CLOSED: 60,
        },
        byCategory: { POULTRY_FARM: 812, HATCHERY: 41, FEED_MILL: 17, BACKYARD: 414 },
        generatedAt: NOW,
      }),
    },
  },
  adminGet: {
    tag: ADMIN_FARMS_TAG,
    operationId: 'adminGetFarm',
    summary: 'Farm detail',
    description:
      'Fresh from the database (never the cache), PII masked, plus `statusHistory` (last 20 status changes).',
    auth: AUTH_ADMIN,
    permission: 'customers.view',
    success: {
      status: 200,
      description: 'The farm with its recent status history',
      data: adminFarmSchema,
      headers: ETAG,
      example: ok({
        ...farmExample,
        statusHistory: [
          {
            fromStatus: 'DRAFT',
            toStatus: 'ACTIVE',
            reason: null,
            actorType: 'OWNER',
            createdAt: NOW,
          },
          {
            fromStatus: null,
            toStatus: 'DRAFT',
            reason: null,
            actorType: 'OWNER',
            createdAt: '2026-11-10T06:00:00.000Z',
          },
        ],
      }),
    },
    errors: [404, 422],
    errorExamples: { 404: ERR.farmNotFound, 422: ERR.badId },
  },
  adminHistory: {
    tag: ADMIN_FARMS_TAG,
    operationId: 'adminFarmAuditHistory',
    summary: 'Farm audit history',
    description:
      'Admin audit rows for the farm (corrections and status actions), newest first, keyset pagination. An unknown farm id returns an empty page (no 404).',
    auth: AUTH_ADMIN,
    permission: 'customers.view',
    success: {
      status: 200,
      description: 'Audit rows, newest first',
      data: auditRow,
      paginated: true,
      example: ok(
        [
          {
            id: IDS.audit,
            actorUserId: IDS.admin,
            action: 'farm.suspend',
            reason: 'Repeated chargebacks under investigation',
            createdAt: NOW,
          },
        ],
        page(),
      ),
    },
    errors: [422],
  },
  adminUpdate: {
    tag: ADMIN_FARMS_TAG,
    operationId: 'adminCorrectFarm',
    summary: 'Correct farm data',
    description:
      'Name, owner name, address line and/or capacities, in any status. `reason` (10–500 chars) plus at least one field. Audited (before/after). The Farm ID never changes.',
    auth: AUTH_ADMIN,
    permission: 'customers.update',
    headers: IF_MATCH,
    requestExample: {
      name: 'Sri Lakshmi Poultry Farm',
      reason: 'Owner called support: name misspelt on invoices',
    },
    success: farm(200, 'Updated farm', {
      ...farmExample,
      name: 'Sri Lakshmi Poultry Farm',
      version: 5,
    }),
    errors: [404, 409, 422],
    errorExamples: { 404: ERR.farmNotFound, 409: ERR.versionConflict, 422: reasonIssue },
  },
  adminAction: {
    tag: ADMIN_FARMS_TAG,
    summary: 'Status action',
    description:
      'State machine enforced: suspend ← ACTIVE · reactivate ← SUSPENDED · close ← ACTIVE / SUSPENDED / NEEDS_ATTENTION · reject ← UNDER_REVIEW / NEEDS_ATTENTION · request-changes ← UNDER_REVIEW (→ NEEDS_ATTENTION, needs `issues[]`). A farm with an open duplicate case must be decided from the review queue (409 `OPEN_REVIEW_CASE`). `reason` required; audited.',
    auth: AUTH_ADMIN,
    headers: IF_MATCH,
    requestExample: { reason: 'Repeated chargebacks under investigation' },
    success: farm(200, 'Updated farm', {
      ...farmExample,
      status: 'SUSPENDED',
      statusReason: 'Repeated chargebacks under investigation',
      version: 5,
    }),
    errors: [404, 409, 422],
    errorExamples: {
      404: ERR.farmNotFound,
      409: [
        {
          summary: 'FARM_STATE_INVALID (action not allowed from this status)',
          message: 'Cannot suspend a SUSPENDED farm',
          details: { reason: 'FARM_STATE_INVALID', from: 'SUSPENDED', action: 'suspend' },
        },
        {
          summary: 'OPEN_REVIEW_CASE',
          message: 'This farm has an open duplicate case; decide it from the review queue',
          details: { reason: 'OPEN_REVIEW_CASE' },
        },
        ERR.versionConflict,
      ],
      422: [
        reasonIssue,
        {
          summary: 'request-changes without issues',
          message: 'Validation failed',
          details: {
            issues: [{ path: 'issues', message: 'list at least one issue for the owner to fix' }],
          },
        },
      ],
    },
  },
} satisfies Record<string, RouteDocs>;

/** Per-action docs for `POST /admin/farms/{id}/<action>` (one operation each). */
/** POST /admin/farms/:id/invoice-name/{approve|reject}. */
export const invoiceNameDocs = (decision: 'approve' | 'reject'): RouteDocs => {
  const approve = decision === 'approve';
  return {
    tag: ADMIN_FARMS_TAG,
    operationId: approve ? 'adminApproveInvoiceName' : 'adminRejectInvoiceName',
    summary: approve ? 'Approve "invoice as farm name"' : 'Reject "invoice as farm name"',
    description: approve
      ? 'The owner chose "Keep farm name & send for review" (GST names differ from the farm name). Approve → invoices use the farm name (`invoiceNameSource: FARM_NAME`). Queue: `GET /admin/farms?invoiceNameReview=PENDING`. Reviewer must not own or have registered the farm (403 `SOD_VIOLATION`). Audited.'
      : 'Reject → invoices stay on the GST trade name; `reason` is shown to the owner as `billing.invoiceNameReview.note`. Reviewer must not own or have registered the farm (403 `SOD_VIOLATION`). Audited.',
    auth: AUTH_ADMIN,
    permission: 'customers.verify',
    headers: IF_MATCH,
    requestExample: {
      reason: approve
        ? 'Farm name is the registered brand of the GSTIN holder (letterhead checked)'
        : 'GST invoices must carry the registered trade name for input tax credit',
    },
    success: farm(200, 'Updated farm', {
      ...farmExample,
      billing: {
        ...farmExample.billing,
        invoiceNameSource: approve ? 'FARM_NAME' : 'GST_TRADE_NAME',
        invoiceName: approve ? 'Sri Lakshmi Poultry' : 'Sri Lakshmi Agro Farms',
        invoiceNameReview: {
          status: approve ? 'APPROVED' : 'REJECTED',
          requestedAt: '2026-11-24T05:01:00.000Z',
          reviewedAt: '2026-11-24T07:30:00.000Z',
          note: approve
            ? 'Farm name is the registered brand of the GSTIN holder (letterhead checked)'
            : 'GST invoices must carry the registered trade name for input tax credit',
        },
      },
      version: 6,
    }),
    errors: [403, 404, 409, 422],
    errorExamples: {
      404: ERR.farmNotFound,
      409: [
        {
          summary: 'Nothing pending',
          message: 'No invoice-name review is pending for this farm',
          details: { reason: 'NO_PENDING_REVIEW' },
        },
        ERR.versionConflict,
      ],
    },
  };
};

export const adminActionDocs = (
  action: 'suspend' | 'reactivate' | 'close' | 'reject' | 'request-changes',
  permission: string,
): RouteDocs => {
  const camel =
    action === 'request-changes'
      ? 'RequestChanges'
      : `${action.charAt(0).toUpperCase()}${action.slice(1)}`;
  const requestChanges = action === 'request-changes';
  return {
    ...FARMS_DOCS.adminAction,
    operationId: `adminFarm${camel}`,
    summary: requestChanges ? 'Request changes from the owner' : `${camel} a farm`,
    permission,
    ...(requestChanges
      ? {
          requestExample: {
            reason: 'ID proof is unreadable; asked the owner to re-upload',
            issues: [
              {
                docType: 'ID_PROOF_BACK',
                code: 'BLURRY',
                message:
                  'The text on the back of your ID is illegible. Please use better lighting.',
              },
            ],
          },
        }
      : {}),
  };
};
