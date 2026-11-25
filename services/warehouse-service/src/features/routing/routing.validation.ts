import Joi from 'joi';

import { DISTRICT, ID, PIN_CODE, STATE_CODE, VERSION } from '../../middleware/http.js';
import { PAGING } from '../../middleware/paging.js';

export const RANK_BY = ['NEAREST', 'PRIORITY', 'MOST_STOCK', 'LOWEST_COST'] as const;
export const STRATEGIES = [
  'NEXT_NEAREST',
  'ALTERNATE_REGIONAL_HUB',
  'NODE_LIST',
  'CENTRAL',
  'HOLD_ORDER',
] as const;
export const EQUIPMENT = ['STANDARD', 'HOPPER', 'CONVEYOR', 'SCALE', 'WEIGHBRIDGE'] as const;
export const TEMP_CLASSES = ['AMB', 'AMB_CTL', 'CC_REF', 'CC_FRZ', 'HAZ'] as const;
export const MAX_RULES = 200;

const PIN = PIN_CODE;
const REASON = Joi.string().trim().min(3).max(500);
const OP = Joi.string().valid('lt', 'gte').required();

/** Typed condition (same union as `@farmx/infra/routing` RoutingCondition). */
const CONDITION = Joi.object({
  type: Joi.string()
    .valid(
      'PIN_RANGE',
      'PIN_LIST',
      'STATE',
      'DISTRICT',
      'CATEGORY',
      'ORDER_VALUE',
      'ORDER_WEIGHT_KG',
      'COLD_REQUIRED',
      'TEMPERATURE_CLASS',
      'HAZARDOUS',
    )
    .required(),
})
  .when(Joi.object({ type: 'PIN_RANGE' }).unknown(), {
    then: Joi.object({ from: PIN.required(), to: PIN.required() }),
  })
  .when(Joi.object({ type: 'PIN_LIST' }).unknown(), {
    then: Joi.object({ pins: Joi.array().items(PIN).min(1).max(2000).unique().required() }),
  })
  .when(Joi.object({ type: 'STATE' }).unknown(), {
    then: Joi.object({
      codes: Joi.array().items(STATE_CODE).min(1).max(40).unique().required(),
    }),
  })
  .when(Joi.object({ type: 'DISTRICT' }).unknown(), {
    then: Joi.object({
      names: Joi.array().items(DISTRICT).min(1).max(200).required(),
    }),
  })
  .when(Joi.object({ type: 'CATEGORY' }).unknown(), {
    then: Joi.object({
      ids: Joi.array().items(ID).min(1).max(100).unique().required(),
      match: Joi.string().valid('any', 'all').default('any'),
    }),
  })
  .when(Joi.object({ type: 'ORDER_VALUE' }).unknown(), {
    then: Joi.object({ op: OP, amount: Joi.number().min(0).max(1e9).required() }),
  })
  .when(Joi.object({ type: 'ORDER_WEIGHT_KG' }).unknown(), {
    then: Joi.object({ op: OP, kg: Joi.number().min(0).max(1e7).required() }),
  })
  .when(Joi.object({ type: Joi.valid('COLD_REQUIRED', 'HAZARDOUS') }).unknown(), {
    then: Joi.object({ value: Joi.boolean().required() }),
  })
  .when(Joi.object({ type: 'TEMPERATURE_CLASS' }).unknown(), {
    then: Joi.object({
      classes: Joi.array()
        .items(Joi.string().valid(...TEMP_CLASSES))
        .min(1)
        .unique()
        .required(),
    }),
  });

const GATES = Joi.object({
  maxDistanceKm: Joi.number().min(1).max(5000).allow(null),
  stockFull: Joi.boolean(),
  dispatchWithinHours: Joi.number().min(1).max(720).allow(null),
  dockEquipment: Joi.array()
    .items(Joi.string().valid(...EQUIPMENT))
    .unique(),
});

const RULE_FIELDS = {
  name: Joi.string().trim().min(3).max(120),
  tag: Joi.string().trim().uppercase().max(30).allow(null),
  conditions: Joi.array().items(CONDITION).max(20),
  primaryWarehouseId: ID.allow(null),
  primaryDockDoorId: ID.allow(null),
  fallbackWarehouseIds: Joi.array().items(ID).max(20).unique(),
  rankBy: Joi.string().valid(...RANK_BY),
  gates: GATES,
  isEnabled: Joi.boolean(),
  isDraft: Joi.boolean(),
  /** 1-based position among live rules (others shift down); omitted = last. */
  priority: Joi.number().integer().min(1).max(MAX_RULES),
};

export const ruleParams = { params: Joi.object({ id: ID.required() }) };

export const rulesQuery = {
  querystring: Joi.object({
    q: Joi.string().trim().min(1).max(60),
    status: Joi.string().valid('ACTIVE', 'INACTIVE', 'DRAFT'),
    tag: Joi.string().trim().uppercase().max(30),
    priorityFrom: Joi.number().integer().min(1),
    priorityTo: Joi.number().integer().min(1),
  }),
};

export const createSchema = {
  body: Joi.object({
    ...RULE_FIELDS,
    name: RULE_FIELDS.name.required(),
    conditions: RULE_FIELDS.conditions.required(),
    rankBy: RULE_FIELDS.rankBy.default('NEAREST'),
    gates: GATES.default({}),
    fallbackWarehouseIds: RULE_FIELDS.fallbackWarehouseIds.default([]),
    reason: REASON.allow(null),
  }),
};

export const patchSchema = {
  ...ruleParams,
  body: Joi.object({
    ...RULE_FIELDS,
    reason: REASON.allow(null),
    expectedVersion: VERSION.required(),
  }).min(2),
};

export const versionSchema = {
  ...ruleParams,
  body: Joi.object({ expectedVersion: VERSION.required(), reason: REASON.allow(null) }),
};

export const deleteSchema = {
  ...ruleParams,
  body: Joi.object({ expectedVersion: VERSION.required(), reason: REASON.required() }),
};

export const duplicateSchema = {
  ...ruleParams,
  body: Joi.object({ name: RULE_FIELDS.name }).empty(null).default({}),
};

export const orderSchema = {
  body: Joi.object({
    ruleIds: Joi.array().items(ID).min(1).max(MAX_RULES).unique().required(),
    reason: REASON.allow(null),
  }),
};

export const historyQuery = {
  querystring: Joi.object({ ...PAGING, page: Joi.forbidden() }),
};
export const ruleHistoryQuery = { ...ruleParams, ...historyQuery };

export const summaryQuery = {
  querystring: Joi.object({
    from: Joi.date().iso(),
    to: Joi.date().iso(),
  }),
};

/** One simulated order: an existing order, or explicit facts. */
const SIM_ORDER = Joi.object({
  orderId: ID,
  pinCode: PIN,
  stateCode: STATE_CODE.allow(null),
  district: DISTRICT.allow(null),
  orderValue: Joi.number().min(0).allow(null),
  weightKg: Joi.number().min(0).allow(null),
  categoryIds: Joi.array().items(ID).max(100).default([]),
  coldRequired: Joi.boolean(),
  temperatureClasses: Joi.array()
    .items(Joi.string().valid(...TEMP_CLASSES))
    .default([]),
  hazardous: Joi.boolean().default(false),
  lat: Joi.number().min(-90).max(90).allow(null),
  lng: Joi.number().min(-180).max(180).allow(null),
  lines: Joi.array()
    .items(Joi.object({ variantId: ID.required(), qty: Joi.number().integer().min(1).required() }))
    .max(100)
    .default([]),
}).xor('orderId', 'pinCode');

const SIM_OPTIONS = {
  /** Also evaluate draft rules (test before publishing). */
  includeDrafts: Joi.boolean().default(false),
  /** Evaluate only these rules (in their priority order). */
  ruleIds: Joi.array().items(ID).max(MAX_RULES).unique(),
};

export const simulateSchema = { body: SIM_ORDER.keys(SIM_OPTIONS) };

export const matrixSchema = {
  body: Joi.object({
    ...SIM_OPTIONS,
    cases: Joi.array()
      .items(
        Joi.object({
          label: Joi.string().trim().max(80).allow(null),
          order: SIM_ORDER.required(),
          expect: Joi.object({ warehouseId: ID, ruleId: ID.allow(null) }),
        }),
      )
      .min(1)
      .max(50)
      .required(),
  }),
};

export const fallbackSchema = {
  body: Joi.object({
    strategy: Joi.string()
      .valid(...STRATEGIES)
      .required(),
    nodeIds: Joi.array().items(ID).max(20).unique().default([]),
    centralWarehouseId: ID.allow(null).default(null),
    allowPartial: Joi.boolean().required(),
    maxDistanceKm: Joi.number().min(1).max(5000).allow(null).default(null),
    reason: REASON.allow(null),
  }),
};

export const throttleSchema = {
  params: Joi.object({ warehouseId: ID.required() }),
  body: Joi.object({
    paused: Joi.boolean().required(),
    maxOrdersPerDay: Joi.number().integer().min(1).max(100_000).allow(null).required(),
    note: Joi.string().trim().max(300).allow(null, ''),
    expectedVersion: VERSION,
  }),
};
