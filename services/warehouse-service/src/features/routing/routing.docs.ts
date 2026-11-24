import Joi from 'joi';

import { IF_VERSION, wmsDoc } from '../../docs/shared.js';
import { PAGE_META } from '../../middleware/paging.js';

export const ROUTING_AREA = 'Routing rules';

const any = Joi.object().unknown(true);
const ADMIN_ONLY =
  'Admin panel only (GLOBAL `routing.manage`). Every change writes a version row + audit and publishes ONE versioned snapshot `warehouse.routing_rules_replaced.v1` that inventory applies at checkout.';

export const routingDocs = (aud: 'panel' | 'admin') => {
  const d = (s: string, p: string, o: Parameters<typeof wmsDoc>[4] = {}) =>
    wmsDoc(aud, ROUTING_AREA, s, p, o);
  return {
    summary: d('Header counts (active, inactive, draft, routed %)', 'fulfilment.view', {
      data: any,
      description:
        'Rule counts (drafts included, max 200), routed % = orders auto-allocated without a manual reallocation ÷ orders in the period (default last 30 days), `loadStatus` BALANCED / STRAINED / SATURATED from the node load, last published snapshot version.',
    }),
    rules: d('Rule table (priority order)', 'fulfilment.view', {
      data: Joi.array().items(any),
      description:
        'Live rules by priority, then drafts. Filters: `q` (name), `status`, `tag`, priority range. Row: conditions + human text, primary node (+ dock door), ordered fallbacks, rankBy, gates, orders routed by it (30 days), version.',
    }),
    rule: d('One rule', 'fulfilment.view', { data: any, errors: [404] }),
    create: d('Add a rule', 'routing.manage', {
      status: 201,
      data: any,
      errors: [409, 422],
      description: `${ADMIN_ONLY} \`priority\` = 1-based position (others shift down; omitted = last). \`isDraft\` saves without publishing. \`rankBy: LOWEST_COST\` → 422 \`NOT_AVAILABLE\` (no fare rates yet). A live rule needs a primary or a fallback node; the dock door must belong to the primary node.`,
    }),
    patch: d('Edit a rule (also publish / unpublish a draft, move priority)', 'routing.manage', {
      data: any,
      errors: [404, 409, 422],
      description: `${ADMIN_ONLY} ${IF_VERSION}`,
    }),
    remove: d('Delete a rule (soft; history kept)', 'routing.manage', {
      data: Joi.object({ deleted: Joi.boolean() }),
      errors: [404, 409, 422],
      description: `${ADMIN_ONLY} Reason required. ${IF_VERSION}`,
    }),
    enable: d('Enable a rule (toggle on)', 'routing.manage', {
      data: any,
      errors: [404, 409],
      description: `${ADMIN_ONLY} A draft must be published first (409 DRAFT). ${IF_VERSION}`,
    }),
    disable: d('Disable a rule (toggle off)', 'routing.manage', {
      data: any,
      errors: [404, 409],
      description: `${ADMIN_ONLY} ${IF_VERSION}`,
    }),
    order: d('Drag reorder', 'routing.manage', {
      data: Joi.array().items(any),
      errors: [409, 422],
      description: `${ADMIN_ONLY} \`ruleIds\` = every live rule exactly once, first = priority 1 (409 ORDER_MISMATCH otherwise).`,
    }),
    duplicate: d('Duplicate a rule (row ⋮)', 'routing.manage', {
      status: 201,
      data: any,
      errors: [404, 409],
      description: 'Creates a disabled draft copy; publish it with PATCH `isDraft: false`.',
    }),
    ruleHistory: d('Rule history (row ⋮)', 'fulfilment.view', {
      paginated: true,
      data: Joi.array().items(any),
      meta: PAGE_META,
      errors: [404],
      description: 'Every version of the rule with its snapshot, action and who.',
    }),
    history: d('Rule History tab', 'fulfilment.view', {
      paginated: true,
      data: Joi.array().items(any),
      meta: PAGE_META,
      description:
        'All rule versions, newest first (CREATE, UPDATE, PUBLISH, UNPUBLISH, ENABLE, DISABLE, REORDER, DELETE). Cursor paging.',
    }),
    audit: d('Audit Logs tab', 'fulfilment.view', {
      paginated: true,
      data: Joi.array().items(any),
      meta: PAGE_META,
      description: 'Rule, fallback, reorder and throttle changes with before / after and reason.',
    }),
    csv: d('Export rules (CSV)', 'fulfilment.view', {
      description: 'Streamed, CSV-injection safe. 5 per minute.',
    }),
    catalog: d('Condition builder options', 'fulfilment.view', {
      data: any,
      description:
        'Condition types + fields, node gates, rankBy (LOWEST_COST `available: false`), fallback strategies, temperature classes, dock equipment, tags, every non-draft warehouse with its dock doors, limits.',
    }),
    simulate: d('Rule Simulation (decision tree)', 'routing.manage', {
      data: any,
      errors: [404, 409, 422],
      description:
        'Runs the same evaluator inventory uses at checkout on real node facts (PIN coverage, stock of the lines, pause / daily cap, cold chain, distance, dock equipment, next dispatch window). Input: `orderId` OR explicit facts (`pinCode`, state, district, value, weight, categories, temperature, hazardous, lat/lng, lines). `includeDrafts` tests drafts; `ruleIds` limits the rules. Returns the winner, the ranked list, the decision tree (per rule: NOT_MATCHED / SELECTED / NO_ELIGIBLE_NODE with failed conditions and per-node gates) and the node facts.',
    }),
    matrix: d('Test Matrix', 'routing.manage', {
      data: any,
      errors: [404, 409, 422],
      description:
        'Up to 50 cases; each gives the winner, rule and fallback use, and pass / fail against `expect` {warehouseId, ruleId}.',
    }),
    fallback: d('Fallback Rules tab / W3.04 fallback policy', 'fulfilment.view', {
      data: any,
      description:
        'Strategy (NEXT_NEAREST, ALTERNATE_REGIONAL_HUB, NODE_LIST, CENTRAL, HOLD_ORDER = "None (quarantine order)"), node list, central node, allow partial, max distance, routing mode label, and the "How it works" `pipeline[]` steps.',
    }),
    fallbackSave: d('Save the fallback policy', 'routing.manage', {
      data: any,
      errors: [422],
      description: `${ADMIN_ONLY} CENTRAL needs \`centralWarehouseId\`; NODE_LIST needs \`nodeIds\`.`,
    }),
    nodeLoad: d('Node Load Factor', 'fulfilment.view', {
      data: any,
      description:
        'Per node: released today vs the daily cap (load %), band (bands from setting `routing.loadBands`, default 70 / 90 %), open floor shipments, dispatched today, paused, cap reached.',
    }),
    throttle: d('Adjust throttle of a node', 'routing.manage', {
      data: any,
      errors: [404, 409, 422],
      description: `${ADMIN_ONLY} \`paused\` stops new allocations to the node; \`maxOrdersPerDay\` caps them (a cap watch republishes when it is reached / freed). Optional \`expectedVersion\`.`,
    }),
    republish: d('Re-publish the routing snapshot', 'routing.manage', {
      data: Joi.object({ version: Joi.number() }),
      description:
        'Sends the current snapshot again with a new version (e.g. after an inventory restore).',
    }),
  };
};
