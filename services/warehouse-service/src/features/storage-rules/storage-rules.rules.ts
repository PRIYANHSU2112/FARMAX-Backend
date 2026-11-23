/**
 * Pure consistency checks of a storage rule against the warehouse's zones and the catalog (no I/O;
 * unit-tested). Rules are NOT enforced until put-away (W8); these warnings make a rule "need
 * review" so nobody believes a broken rule protects anything.
 */

export type RuleType = 'SEGREGATION' | 'HAZARD_CLASS' | 'FOOD_GRADE_ZONE' | 'INCOMPATIBLE';

export interface RuleFacts {
  type: RuleType;
  subjectCategoryIds: readonly string[];
  keepAwayCategoryIds: readonly string[];
  allowedZoneId: string | null;
  minDistanceM: number | null;
}

export interface ZoneFacts {
  id: string;
  code: string;
  status: string;
  temperatureClass: string;
  isFoodGrade: boolean;
  productCategoryIds: readonly string[];
}

export interface RuleWarning {
  code:
    | 'ZONE_MISSING'
    | 'ZONE_INACTIVE'
    | 'ZONE_NOT_FOOD_GRADE'
    | 'ZONE_NOT_HAZARD'
    | 'CATEGORY_UNKNOWN'
    | 'SAME_ZONE_CONFLICT';
  message: string;
}

/**
 * `categories` = visible catalog categories, or null when the catalog could not be read (the
 * category check is then skipped instead of flagging every rule).
 */
export function ruleWarnings(
  rule: RuleFacts,
  zones: readonly ZoneFacts[],
  categories: ReadonlySet<string> | null,
): RuleWarning[] {
  const out: RuleWarning[] = [];
  const zone =
    rule.allowedZoneId === null ? undefined : zones.find((z) => z.id === rule.allowedZoneId);
  if (rule.allowedZoneId !== null && zone === undefined)
    out.push({ code: 'ZONE_MISSING', message: 'The allowed zone no longer exists' });
  if (zone !== undefined && zone.status !== 'ACTIVE')
    out.push({ code: 'ZONE_INACTIVE', message: `Zone ${zone.code} is not active` });
  if (zone !== undefined && rule.type === 'FOOD_GRADE_ZONE' && !zone.isFoodGrade)
    out.push({
      code: 'ZONE_NOT_FOOD_GRADE',
      message: `Zone ${zone.code} is not marked food-grade`,
    });
  if (zone !== undefined && rule.type === 'HAZARD_CLASS' && zone.temperatureClass !== 'HAZ')
    out.push({
      code: 'ZONE_NOT_HAZARD',
      message: `Zone ${zone.code} is not a special (hazardous) zone`,
    });

  if (categories !== null) {
    const unknown = [...rule.subjectCategoryIds, ...rule.keepAwayCategoryIds].filter(
      (id) => !categories.has(id),
    );
    if (unknown.length > 0)
      out.push({
        code: 'CATEGORY_UNKNOWN',
        message: `${String(unknown.length)} category(ies) are deleted or hidden in the catalog`,
      });
  }

  // Separation is impossible inside one zone: a zone set up to hold both sides breaks the rule.
  if (rule.keepAwayCategoryIds.length > 0) {
    for (const z of zones) {
      if (z.status !== 'ACTIVE') continue;
      const holdsSubject = rule.subjectCategoryIds.some((c) => z.productCategoryIds.includes(c));
      const holdsOther = rule.keepAwayCategoryIds.some((c) => z.productCategoryIds.includes(c));
      if (holdsSubject && holdsOther)
        out.push({
          code: 'SAME_ZONE_CONFLICT',
          message: `Zone ${z.code} is set up to hold both sides of this rule (0 m apart)`,
        });
    }
  }
  return out;
}
