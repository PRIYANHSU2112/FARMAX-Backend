import { ConflictError, ValidationError } from '@farmx/common/errors';

import type {
  CapacityInput,
  CapacityMetric,
  CapacityPeriod,
  FarmCategory,
  FarmStatus,
  ProductionType,
} from './farms.types.js';

/** Farm ID type code from the PRIMARY production type (D-25). */
export const TYPE_CODES: Readonly<Record<ProductionType, string>> = {
  LAYER: 'L',
  BROILER: 'B',
  BROILER_BREEDER: 'BB',
  LAYER_BREEDER: 'LB',
  HATCHERY: 'H',
  FEED_MILL: 'FM',
  BACKYARD: 'R',
};

/** `FX-WG-L-00418`; widens past 99999 instead of wrapping. */
export const buildFarmCode = (
  territoryCode: string,
  type: ProductionType,
  serial: number,
): string => `FX-${territoryCode}-${TYPE_CODES[type]}-${String(serial).padStart(5, '0')}`;

export const farmCodePreview = (
  territoryCode: string | null,
  type: ProductionType | undefined,
): string | null =>
  territoryCode === null || type === undefined
    ? null
    : `FX-${territoryCode}-${TYPE_CODES[type]}-•••••`;

export const FARM_CODE_PATTERN = /^FX-[A-Z]{2,3}-[A-Z]{1,2}-\d{5,}$/;

export const normalizeName = (name: string): string =>
  name.trim().toLowerCase().replace(/\s+/g, ' ');

export interface CapacityRule {
  metric: CapacityMetric;
  periods: readonly CapacityPeriod[];
  required: boolean;
  unit: string;
}

interface CategoryRule {
  title: string;
  subtitle: string;
  /** Selectable production types; a single fixed type is applied automatically. */
  productionTypes: readonly ProductionType[];
  capacity: readonly CapacityRule[];
  requiredDocs: readonly string[];
  kycRequired: boolean;
}

const BIRDS: CapacityRule = {
  metric: 'BIRDS',
  periods: ['STANDING', 'PER_CYCLE'],
  required: true,
  unit: 'birds',
};

/** Drives the "What do you run?" screen and step-2 validation (GET /farms/categories). */
export const CATEGORY_RULES: Readonly<Record<FarmCategory, CategoryRule>> = {
  POULTRY_FARM: {
    title: 'Poultry farm',
    subtitle: 'Layer, broiler or breeder birds',
    productionTypes: ['LAYER', 'BROILER', 'BROILER_BREEDER', 'LAYER_BREEDER'],
    capacity: [BIRDS],
    requiredDocs: ['AADHAAR', 'PAN', 'GSTIN'],
    kycRequired: true,
  },
  HATCHERY: {
    title: 'Hatchery',
    subtitle: 'Capacity in eggs per setting or week',
    productionTypes: ['HATCHERY'],
    capacity: [
      { metric: 'EGGS', periods: ['PER_SETTING', 'PER_WEEK'], required: true, unit: 'eggs' },
      { metric: 'FEED_TONNES', periods: ['PER_MONTH'], required: false, unit: 'tonnes' },
    ],
    requiredDocs: ['AADHAAR', 'PAN', 'GSTIN'],
    kycRequired: true,
  },
  FEED_MILL: {
    title: 'Feed mill',
    subtitle: 'Capacity in tonnes per hour or day',
    productionTypes: ['FEED_MILL'],
    capacity: [
      { metric: 'FEED_TONNES', periods: ['PER_HOUR', 'PER_DAY'], required: true, unit: 'tonnes' },
    ],
    requiredDocs: ['AADHAAR', 'PAN', 'GSTIN'],
    kycRequired: true,
  },
  BACKYARD: {
    title: 'Backyard or small buyer',
    subtitle: 'Mobile and address only · no GST',
    productionTypes: ['BACKYARD'],
    capacity: [{ ...BIRDS, required: false }],
    requiredDocs: [],
    kycRequired: false,
  },
};

/** Validates step-2 production types + capacities for a category; returns the ordered types. */
export function validateDetails(
  category: FarmCategory,
  requested: readonly ProductionType[] | undefined,
  capacities: readonly CapacityInput[],
): ProductionType[] {
  const rule = CATEGORY_RULES[category];
  const types =
    rule.productionTypes.length === 1 ? [...rule.productionTypes] : [...(requested ?? [])];
  const issues: { path: string; message: string }[] = [];
  if (types.length === 0)
    issues.push({ path: 'productionTypes', message: 'pick at least one production type' });
  types.forEach((type, i) => {
    if (!rule.productionTypes.includes(type)) {
      issues.push({
        path: `productionTypes.${i}`,
        message: `${type} is not allowed for ${category}`,
      });
    }
  });
  capacities.forEach((cap, i) => {
    const capRule = rule.capacity.find((r) => r.metric === cap.metric);
    if (!types.includes(cap.productionType)) {
      issues.push({
        path: `capacities.${i}.productionType`,
        message: 'not one of the selected production types',
      });
    } else if (!capRule?.periods.includes(cap.period)) {
      issues.push({
        path: `capacities.${i}`,
        message: `${cap.metric}/${cap.period} is not valid for ${category}`,
      });
    }
  });
  for (const type of types) {
    for (const capRule of rule.capacity.filter((r) => r.required)) {
      if (!capacities.some((c) => c.productionType === type && c.metric === capRule.metric)) {
        issues.push({ path: 'capacities', message: `${type} needs a ${capRule.metric} capacity` });
      }
    }
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return types;
}

/** Allowed status transitions (§4 of the plan). Anything else → 409. */
const TRANSITIONS: Readonly<Record<FarmStatus, readonly FarmStatus[]>> = {
  DRAFT: ['ACTIVE', 'UNDER_REVIEW', 'CLOSED'],
  NEEDS_ATTENTION: ['ACTIVE', 'UNDER_REVIEW', 'CLOSED'],
  UNDER_REVIEW: ['ACTIVE', 'MERGED', 'NEEDS_ATTENTION', 'REJECTED'],
  ACTIVE: ['SUSPENDED', 'CLOSED'],
  SUSPENDED: ['ACTIVE', 'CLOSED'],
  REJECTED: [],
  MERGED: [],
  CLOSED: [],
};

export const canTransition = (from: FarmStatus, to: FarmStatus): boolean =>
  TRANSITIONS[from].includes(to);

export function assertTransition(from: FarmStatus, to: FarmStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictError(`A ${from} farm cannot become ${to}`, {
      details: { reason: 'FARM_STATE_INVALID', from, to },
    });
  }
}

/** Statuses in which the owner may still edit registration steps. */
export const EDITABLE: readonly FarmStatus[] = ['DRAFT', 'NEEDS_ATTENTION'];

export function assertEditable(status: FarmStatus): void {
  if (!EDITABLE.includes(status)) {
    throw new ConflictError('This farm can no longer be edited here', {
      details: { reason: 'FARM_STATE_INVALID', status },
    });
  }
}
