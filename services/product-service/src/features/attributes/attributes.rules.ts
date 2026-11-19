import type {
  AttributeDef,
  AttributeIssue,
  ComplianceFlags,
  EffectiveAttribute,
} from './attributes.types.js';

/**
 * Effective attributes of a category = definitions along its path (root → self); a deeper
 * category redefining a key overrides its ancestor (children refine). Sorted for display.
 */
export const effectiveAttributes = (
  pathIds: readonly string[],
  defs: readonly AttributeDef[],
): EffectiveAttribute[] => {
  const selfId = pathIds.at(-1);
  const depth = new Map(pathIds.map((id, index) => [id, index]));
  const byKey = new Map<string, AttributeDef>();
  for (const def of [...defs].sort(
    (a, b) => (depth.get(a.categoryId) ?? -1) - (depth.get(b.categoryId) ?? -1),
  )) {
    if (depth.has(def.categoryId)) byKey.set(def.key, def);
  }
  return [...byKey.values()]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
    .map((def) => ({ ...def, inherited: def.categoryId !== selfId }));
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates product attribute values against the effective definitions (all issues at once).
 * Drafts may be incomplete: enforceRequired is on for submit/publish, off for saves.
 */
export const validateAttributeValues = (
  defs: readonly EffectiveAttribute[],
  values: Readonly<Record<string, unknown>>,
  { enforceRequired = true }: { enforceRequired?: boolean } = {},
): AttributeIssue[] => {
  const issues: AttributeIssue[] = [];
  const known = new Map(defs.map((def) => [def.key, def]));
  for (const key of Object.keys(values)) {
    if (!known.has(key))
      issues.push({ path: `attributes.${key}`, message: 'Not defined for this category' });
  }
  for (const def of defs) {
    const path = `attributes.${def.key}`;
    const value = values[def.key];
    if (value === undefined || value === null || value === '') {
      if (def.isRequired && enforceRequired)
        issues.push({ path, message: `${def.label} is required` });
      continue;
    }
    const fail = (message: string) => issues.push({ path, message });
    switch (def.dataType) {
      case 'TEXT':
        if (typeof value !== 'string' || value.length > 500) fail('Must be text (max 500)');
        break;
      case 'NUMBER':
        if (typeof value !== 'number' || !Number.isFinite(value)) fail('Must be a number');
        break;
      case 'BOOLEAN':
        if (typeof value !== 'boolean') fail('Must be true or false');
        break;
      case 'DATE':
        if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value)))
          fail('Must be a date (YYYY-MM-DD)');
        break;
      case 'SELECT':
        if (typeof value !== 'string' || !def.options.includes(value))
          fail(`Must be one of: ${def.options.join(', ')}`);
        break;
      case 'MULTI_SELECT':
        if (
          !Array.isArray(value) ||
          value.length === 0 ||
          value.some((v) => typeof v !== 'string' || !def.options.includes(v))
        )
          fail(`Must be a list of: ${def.options.join(', ')}`);
        break;
    }
  }
  return issues;
};

export const EMPTY_FLAGS: ComplianceFlags = {
  requiresRegistration: false,
  requiresDrugLicense: false,
  requiresManufacturingLicense: false,
  requiresWithdrawal: false,
  requiresColdChain: false,
  requiredDocTypes: [],
  allowedSchedules: [],
};

/**
 * Effective compliance along the path: tighten-only. Booleans OR, required documents union,
 * allowed schedules intersect (an empty list means "any").
 */
export const mergeCompliance = (profiles: readonly ComplianceFlags[]): ComplianceFlags =>
  profiles.reduce<ComplianceFlags>(
    (acc, p) => ({
      requiresRegistration: acc.requiresRegistration || p.requiresRegistration,
      requiresDrugLicense: acc.requiresDrugLicense || p.requiresDrugLicense,
      requiresManufacturingLicense:
        acc.requiresManufacturingLicense || p.requiresManufacturingLicense,
      requiresWithdrawal: acc.requiresWithdrawal || p.requiresWithdrawal,
      requiresColdChain: acc.requiresColdChain || p.requiresColdChain,
      requiredDocTypes: [...new Set([...acc.requiredDocTypes, ...p.requiredDocTypes])],
      allowedSchedules:
        acc.allowedSchedules.length === 0
          ? [...p.allowedSchedules]
          : p.allowedSchedules.length === 0
            ? acc.allowedSchedules
            : acc.allowedSchedules.filter((s) => p.allowedSchedules.includes(s)),
    }),
    EMPTY_FLAGS,
  );
