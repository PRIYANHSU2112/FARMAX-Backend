import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { IF_VERSION, staffDoc } from '../../docs/shared.js';

export const ADMIN_RULES_TAG = 'Admin Warehouse Storage Rules';

const T = ADMIN_RULES_TAG;
const conf = 'warehouse.configure';
const NOT_ENFORCED =
  'Rules are SAVED and checked for consistency but NOT ENFORCED until put-away (W8) places stock: every response carries `enforcement: "NOT_ENFORCED"`; show a "Saved, enforced when put-away goes live" badge, never "blocked" or "compliant". Minimum distance is measured between zones (same zone = 0 m).';

const category = Joi.object({ id: Joi.string().guid(), name: Joi.string().allow(null) });
const rule = Joi.object({
  id: Joi.string().guid(),
  type: Joi.string().valid('SEGREGATION', 'HAZARD_CLASS', 'FOOD_GRADE_ZONE', 'INCOMPATIBLE'),
  name: Joi.string().example('Chemical Separation'),
  subjectCategories: Joi.array().items(category),
  keepAwayCategories: Joi.array().items(category),
  allowedZone: Joi.object({ id: Joi.string(), code: Joi.string(), name: Joi.string() }).allow(null),
  minDistanceM: Joi.string().allow(null).example('3.00'),
  notes: Joi.string().allow(null),
  status: Joi.string(),
  version: Joi.number().integer(),
  enforcement: Joi.string().valid('NOT_ENFORCED'),
  warnings: Joi.array().items(Joi.object({ code: Joi.string(), message: Joi.string() })),
}).meta({ className: 'StorageRule' });

export const RULE_DOCS = {
  list: staffDoc(T, 'Storage compatibility rules (W2.08)', 'warehouse.view', {
    data: Joi.array().items(rule),
    description: `Filter by type (tabs). The list is bounded (≤ 200) so the UI pages it. ${NOT_ENFORCED}`,
  }),
  summary: staffDoc(T, 'Rule KPIs', 'warehouse.view', {
    description:
      'Active rules, food-grade zones, restricted items (categories that are the subject of active hazard / segregation rules), items needing review (active rules with warnings: inactive or missing zone, deleted category, or a zone set up to hold both sides).',
    data: Joi.object({
      activeRules: Joi.number().integer(),
      foodGradeZones: Joi.number().integer(),
      restrictedItems: Joi.number().integer(),
      itemsNeedingReview: Joi.number().integer(),
      enforcement: Joi.string(),
      modules: Joi.object({ putaway: Joi.boolean() }),
    }).meta({ className: 'StorageRulesSummary' }),
  }),
  create: staffDoc(T, 'Add rule', conf, {
    status: 201,
    data: rule,
    errors: [404, 409, 422],
    description: `Segregation / incompatible need "cannot be stored with"; food-grade and hazard rules need the zone. Distance in metres or feet (stored in metres). ${NOT_ENFORCED}`,
  }),
  update: staffDoc(T, 'Edit rule', conf, {
    data: rule,
    errors: [404, 409, 422],
    description: IF_VERSION,
  }),
  remove: staffDoc(T, 'Delete rule', conf, { status: 204 }),
} satisfies Record<string, RouteDocs>;
