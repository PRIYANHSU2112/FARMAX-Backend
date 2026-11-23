/**
 * Pure warehouse rules (no I/O; unit-tested): the status state machine and the setup checklist
 * that gates activation (W2.02 wizard, D-56). Team members are optional.
 */
import type {
  SetupStep,
  StatusAction,
  WarehouseRecord,
  WarehouseStatus,
} from './warehouses.types.js';

/** Allowed transitions: action → (from → to). */
const TRANSITIONS: Record<StatusAction, { from: readonly WarehouseStatus[]; to: WarehouseStatus }> =
  {
    activate: { from: ['SETUP'], to: 'ACTIVE' },
    limit: { from: ['ACTIVE'], to: 'LIMITED' },
    deactivate: { from: ['ACTIVE', 'LIMITED'], to: 'INACTIVE' },
    reactivate: { from: ['LIMITED', 'INACTIVE'], to: 'ACTIVE' },
  };

/** The target status, or null when the action is not allowed from `from`. */
export const nextStatus = (from: WarehouseStatus, action: StatusAction): WarehouseStatus | null => {
  const rule = TRANSITIONS[action];
  return rule.from.includes(from) ? rule.to : null;
};

/** A reason is required for anything that reduces service (limit, deactivate). */
export const needsReason = (action: StatusAction): boolean =>
  action === 'limit' || action === 'deactivate';

/** Facts the checklist needs from other features (service areas …). */
export interface SetupFacts {
  /** DISTRICT areas with at least one PIN. */
  districtAreas: number;
  /** PINs still in the IMPORTED area (not moved to a district yet). */
  unassignedPins: number;
  /** ACTIVE storage zones (storage feature). */
  activeZones: number;
  /** Weekdays marked open (calendar feature). */
  openDays: number;
}

const FIELD_LABELS: Record<string, string> = {
  district: 'district',
  managerUserId: 'manager / in-charge',
  capacityKg: 'storage capacity',
  temperatureClasses: 'temperature capability',
};

export function setupSteps(w: WarehouseRecord, facts: SetupFacts): SetupStep[] {
  const details: string[] = [];
  if (w.district === null) details.push('Add the district');
  if (w.managerUserId === null) details.push('Choose a manager / in-charge');
  if (w.phone === null) details.push('Add the phone number');
  if (w.capacityKg === null) details.push('Add the storage capacity');
  if (w.temperatureClasses.length === 0) details.push('Choose the temperature capability');

  const area: string[] = [];
  if (w.isAllocatable && facts.districtAreas === 0 && facts.unassignedPins === 0)
    area.push('Assign at least one district with PIN codes (orders are routed by PIN)');

  const storage = facts.activeZones === 0 ? ['Add at least one active storage zone'] : [];
  const calendar = facts.openDays === 0 ? ['Set the weekly working hours'] : [];

  const review = w.reviewFields.map(
    (field) => `Confirm the imported ${FIELD_LABELS[field] ?? field}`,
  );

  return [
    { key: 'details', done: details.length === 0, issues: details },
    { key: 'serviceArea', done: area.length === 0, issues: area },
    { key: 'storage', done: storage.length === 0, issues: storage },
    { key: 'calendar', done: calendar.length === 0, issues: calendar },
    { key: 'review', done: review.length === 0, issues: review },
  ];
}

export const setupProgress = (steps: readonly SetupStep[]) => ({
  done: steps.filter((s) => s.done).length,
  total: steps.length,
});

/** used ÷ capacity × 100 (1 decimal); null when capacity is not set. */
export const usedPct = (usedKg: number, capacityKg: number | null): number | null =>
  capacityKg === null || capacityKg <= 0 ? null : Math.round((usedKg / capacityKg) * 1000) / 10;
