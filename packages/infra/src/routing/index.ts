/**
 * Order routing rules (D-57b W3.12): ONE pure evaluator shared by warehouse-service (rule
 * simulation, allocation candidates) and inventory-service (checkout allocation order). No I/O.
 *
 * Rules are tried by priority (1 = first). A rule matches when ALL its conditions hold; its
 * candidates (primary, then ordered fallbacks) must serve the PIN, be routable, not throttled and
 * pass the node gates. The best candidates are ranked by `rankBy`. No rule / no candidate → the
 * fallback strategy orders the PIN's warehouses. Every step is recorded in `trace`.
 */

export type RoutingCondition =
  | { type: 'PIN_RANGE'; from: string; to: string }
  | { type: 'PIN_LIST'; pins: string[] }
  | { type: 'STATE'; codes: string[] }
  | { type: 'DISTRICT'; names: string[] }
  | { type: 'CATEGORY'; ids: string[]; match: 'any' | 'all' }
  | { type: 'ORDER_VALUE'; op: 'lt' | 'gte'; amount: number }
  | { type: 'ORDER_WEIGHT_KG'; op: 'lt' | 'gte'; kg: number }
  | { type: 'COLD_REQUIRED'; value: boolean }
  | { type: 'TEMPERATURE_CLASS'; classes: string[] }
  | { type: 'HAZARDOUS'; value: boolean };

export interface RoutingGates {
  maxDistanceKm?: number | null;
  /** The node must hold every line in full. */
  stockFull?: boolean;
  /** The node must be able to dispatch within N hours (next cut-off / opening). */
  dispatchWithinHours?: number | null;
  /** The node needs one of these dock door equipments (heavy loads). */
  dockEquipment?: string[];
}

export type RankBy = 'NEAREST' | 'PRIORITY' | 'MOST_STOCK' | 'LOWEST_COST';

export interface RoutingRuleV1 {
  id: string;
  name: string;
  priority: number;
  conditions: RoutingCondition[];
  primaryWarehouseId: string | null;
  fallbackWarehouseIds: string[];
  rankBy: RankBy;
  gates: RoutingGates;
  isEnabled: boolean;
}

export type FallbackStrategy =
  'NEXT_NEAREST' | 'ALTERNATE_REGIONAL_HUB' | 'NODE_LIST' | 'CENTRAL' | 'HOLD_ORDER';

export interface RoutingFallbackV1 {
  strategy: FallbackStrategy;
  nodeIds: string[];
  centralWarehouseId: string | null;
  /** Fallback nodes farther than this are skipped (null / absent = no limit). */
  maxDistanceKm?: number | null;
}

export interface RoutingOrder {
  pinCode: string;
  stateCode: string | null;
  district: string | null;
  /** Rupees. */
  value: number | null;
  weightKg: number | null;
  categoryIds: string[];
  coldRequired: boolean;
  temperatureClasses: string[];
  hazardous: boolean;
  lat: number | null;
  lng: number | null;
}

export interface RoutingNode {
  warehouseId: string;
  type: 'MOTHER' | 'DEPOT';
  lat: number | null;
  lng: number | null;
  /** Lower = preferred (coverage rank, then warehouse priority). */
  priority: number;
  /** Serves the delivery PIN. */
  covered: boolean;
  routable: boolean;
  throttled: boolean;
  coldChain: boolean;
  fullStock: boolean;
  stockUnits: number;
  equipment: string[];
  dispatchWithinHours: number | null;
}

export interface RoutingCandidateTrace {
  warehouseId: string;
  passed: boolean;
  gate: string | null;
  distanceKm: number | null;
}

export interface RoutingTraceStep {
  ruleId: string;
  name: string;
  matched: boolean;
  failedConditions: string[];
  candidates: RoutingCandidateTrace[];
}

export interface RoutingDecision {
  ruleId: string | null;
  ruleName: string | null;
  /** Warehouse ids best-first (rule winners, then the rest by the fallback strategy). */
  ordered: string[];
  fallbackUsed: boolean;
  /** HOLD_ORDER fallback: allocate nothing automatically (WMS raises an allocation issue). */
  hold: boolean;
  trace: RoutingTraceStep[];
}

export const distanceKm = (
  a: { lat: number | null; lng: number | null },
  b: { lat: number | null; lng: number | null },
): number | null => {
  if (a.lat === null || a.lng === null || b.lat === null || b.lng === null) return null;
  const r = (x: number) => (x * Math.PI) / 180;
  const h =
    Math.sin(r(b.lat - a.lat) / 2) ** 2 +
    Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return Math.round(6371 * 2 * Math.asin(Math.sqrt(h)) * 10) / 10;
};

/** Human text of one condition (rule table, trace). */
export const conditionLabel = (c: RoutingCondition): string => {
  switch (c.type) {
    case 'PIN_RANGE':
      return `PIN ${c.from}–${c.to}`;
    case 'PIN_LIST':
      return `PIN in [${String(c.pins.length)}]`;
    case 'STATE':
      return `state in ${c.codes.join(',')}`;
    case 'DISTRICT':
      return `district in ${c.names.join(',')}`;
    case 'CATEGORY':
      return `category ${c.match} of ${String(c.ids.length)}`;
    case 'ORDER_VALUE':
      return `value ${c.op} ${String(c.amount)}`;
    case 'ORDER_WEIGHT_KG':
      return `weight ${c.op} ${String(c.kg)} kg`;
    case 'COLD_REQUIRED':
      return `cold ${String(c.value)}`;
    case 'TEMPERATURE_CLASS':
      return `temperature in ${c.classes.join(',')}`;
    case 'HAZARDOUS':
      return `hazardous ${String(c.value)}`;
  }
};

const holds = (c: RoutingCondition, o: RoutingOrder): boolean => {
  switch (c.type) {
    case 'PIN_RANGE':
      return o.pinCode >= c.from && o.pinCode <= c.to;
    case 'PIN_LIST':
      return c.pins.includes(o.pinCode);
    case 'STATE':
      return o.stateCode !== null && c.codes.includes(o.stateCode);
    case 'DISTRICT':
      return (
        o.district !== null && c.names.some((n) => n.toLowerCase() === o.district?.toLowerCase())
      );
    case 'CATEGORY':
      return c.match === 'all'
        ? c.ids.every((id) => o.categoryIds.includes(id))
        : c.ids.some((id) => o.categoryIds.includes(id));
    case 'ORDER_VALUE':
      return o.value !== null && (c.op === 'lt' ? o.value < c.amount : o.value >= c.amount);
    case 'ORDER_WEIGHT_KG':
      return o.weightKg !== null && (c.op === 'lt' ? o.weightKg < c.kg : o.weightKg >= c.kg);
    case 'COLD_REQUIRED':
      return o.coldRequired === c.value;
    case 'TEMPERATURE_CLASS':
      return o.temperatureClasses.some((t) => c.classes.includes(t));
    case 'HAZARDOUS':
      return o.hazardous === c.value;
  }
};

/** Conditions of one rule against an order (pure; used for previews). */
export const matchRule = (rule: Pick<RoutingRuleV1, 'conditions'>, order: RoutingOrder) => {
  const failed = rule.conditions.filter((c) => !holds(c, order)).map(conditionLabel);
  return { matched: failed.length === 0, failed };
};

const gateOf = (
  n: RoutingNode,
  g: RoutingGates,
  o: RoutingOrder,
  km: number | null,
): string | null => {
  if (!n.covered) return 'NOT_IN_SERVICE_AREA';
  if (!n.routable) return 'NOT_ROUTABLE';
  if (n.throttled) return 'THROTTLED';
  if (o.coldRequired && !n.coldChain) return 'NO_COLD_CHAIN';
  if (g.maxDistanceKm != null && (km === null || km > g.maxDistanceKm)) return 'MAX_DISTANCE';
  if (g.stockFull === true && !n.fullStock) return 'STOCK_NOT_FULL';
  if (
    g.dispatchWithinHours != null &&
    (n.dispatchWithinHours === null || n.dispatchWithinHours > g.dispatchWithinHours)
  )
    return 'DISPATCH_WINDOW';
  if (
    g.dockEquipment !== undefined &&
    g.dockEquipment.length > 0 &&
    !g.dockEquipment.some((e) => n.equipment.includes(e))
  )
    return 'DOCK_CAPABILITY';
  return null;
};

const fallbackOrder = (
  f: RoutingFallbackV1,
  nodes: readonly RoutingNode[],
  order: RoutingOrder,
): string[] => {
  const limit = f.maxDistanceKm ?? null;
  const usable = nodes.filter((n) => {
    if (!n.covered || !n.routable || n.throttled || (order.coldRequired && !n.coldChain))
      return false;
    const km = limit === null ? null : distanceKm(order, n);
    return km === null || limit === null || km <= limit;
  });
  const near = [...usable].sort(
    (a, b) =>
      (distanceKm(order, a) ?? Number.MAX_SAFE_INTEGER) -
        (distanceKm(order, b) ?? Number.MAX_SAFE_INTEGER) || a.priority - b.priority,
  );
  switch (f.strategy) {
    case 'ALTERNATE_REGIONAL_HUB':
      return [
        ...near.filter((n) => n.type === 'MOTHER'),
        ...near.filter((n) => n.type !== 'MOTHER'),
      ].map((n) => n.warehouseId);
    case 'NODE_LIST':
      return [
        ...f.nodeIds.filter((id) => usable.some((n) => n.warehouseId === id)),
        ...near.map((n) => n.warehouseId).filter((id) => !f.nodeIds.includes(id)),
      ];
    case 'CENTRAL': {
      const c = f.centralWarehouseId;
      return [
        ...(c !== null && usable.some((n) => n.warehouseId === c) ? [c] : []),
        ...near.map((n) => n.warehouseId).filter((id) => id !== c),
      ];
    }
    case 'HOLD_ORDER':
    case 'NEXT_NEAREST':
      return near.map((n) => n.warehouseId);
  }
};

/** The routing decision for one order over the warehouses that could serve it. */
export function evaluateRouting(
  rules: readonly RoutingRuleV1[],
  fallback: RoutingFallbackV1,
  order: RoutingOrder,
  nodes: readonly RoutingNode[],
): RoutingDecision {
  const trace: RoutingTraceStep[] = [];
  const byId = new Map(nodes.map((n) => [n.warehouseId, n]));
  for (const r of [...rules].filter((x) => x.isEnabled).sort((a, b) => a.priority - b.priority)) {
    const m = matchRule(r, order);
    if (!m.matched) {
      trace.push({
        ruleId: r.id,
        name: r.name,
        matched: false,
        failedConditions: m.failed,
        candidates: [],
      });
      continue;
    }
    const ids = [
      ...new Set([
        ...(r.primaryWarehouseId === null ? [] : [r.primaryWarehouseId]),
        ...r.fallbackWarehouseIds,
      ]),
    ];
    const cands = ids.map((id, i) => {
      const n = byId.get(id);
      const km = n === undefined ? null : distanceKm(order, n);
      const gate = n === undefined ? 'NOT_IN_SERVICE_AREA' : gateOf(n, r.gates, order, km);
      return {
        warehouseId: id,
        passed: gate === null,
        gate,
        distanceKm: km,
        idx: i,
        stock: n?.stockUnits ?? 0,
      };
    });
    trace.push({
      ruleId: r.id,
      name: r.name,
      matched: true,
      failedConditions: [],
      candidates: cands.map((c) => ({
        warehouseId: c.warehouseId,
        passed: c.passed,
        gate: c.gate,
        distanceKm: c.distanceKm,
      })),
    });
    const passed = cands.filter((c) => c.passed);
    if (passed.length === 0) continue;
    const ranked = [...passed].sort((a, b) =>
      r.rankBy === 'NEAREST'
        ? (a.distanceKm ?? Number.MAX_SAFE_INTEGER) - (b.distanceKm ?? Number.MAX_SAFE_INTEGER) ||
          a.idx - b.idx
        : r.rankBy === 'MOST_STOCK'
          ? b.stock - a.stock || a.idx - b.idx
          : a.idx - b.idx,
    );
    const head = ranked.map((c) => c.warehouseId);
    const rest = fallbackOrder(fallback, nodes, order).filter((id) => !head.includes(id));
    return {
      ruleId: r.id,
      ruleName: r.name,
      ordered: [...head, ...rest],
      fallbackUsed: false,
      hold: false,
      trace,
    };
  }
  return {
    ruleId: null,
    ruleName: null,
    ordered: fallbackOrder(fallback, nodes, order),
    fallbackUsed: true,
    hold: fallback.strategy === 'HOLD_ORDER',
    trace,
  };
}
