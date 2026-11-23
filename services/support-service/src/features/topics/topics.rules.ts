/**
 * Dynamic priority (pure). Rules are evaluated in sortOrder; the FIRST rule whose every present
 * condition holds sets priority + reason (+ team). No match → the topic's default.
 */
export type Priority = 'URGENT' | 'HIGH' | 'MEDIUM' | 'LOW';
export type Team = 'SUPPORT' | 'VET' | 'LOGISTICS' | 'FINANCE' | 'QUALITY' | 'WAREHOUSE';

export interface RuleConditions {
  /** Any order line in one of these temperature classes (e.g. CC_REF, CC_FRZ = cold chain). */
  temperatureClasses?: string[];
  /** Order grand total ≥ this (rupees). */
  minOrderAmount?: number;
  /** Any keyword (case-insensitive, whole word or phrase) in the requester's text. */
  keywords?: string[];
  /** CUSTOMER · VENDOR · LOGISTICS_PARTNER · INTERNAL */
  requesterTypes?: string[];
}

export interface PriorityRule {
  id: string;
  app: string | null;
  topicCode: string | null;
  conditions: RuleConditions;
  priority: Priority;
  reasonLabel: string;
  team: Team | null;
}

export interface TicketFacts {
  app: string;
  topicCode: string;
  requesterType: string;
  text: string;
  orderAmount: number | null;
  temperatureClasses: readonly string[];
}

export interface PriorityDecision {
  priority: Priority;
  reason: string | null;
  team: Team;
  ruleId: string | null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const hasKeyword = (text: string, keywords: readonly string[]) =>
  keywords.some((k) => k.trim() !== '' && new RegExp(`\\b${escape(k.trim())}\\b`, 'i').test(text));

export function matches(rule: PriorityRule, facts: TicketFacts): boolean {
  if (rule.app !== null && rule.app !== facts.app) return false;
  if (rule.topicCode !== null && rule.topicCode !== facts.topicCode) return false;
  const c = rule.conditions;
  if (
    c.temperatureClasses?.length &&
    !c.temperatureClasses.some((t) => facts.temperatureClasses.includes(t))
  )
    return false;
  if (
    c.minOrderAmount !== undefined &&
    (facts.orderAmount === null || facts.orderAmount < c.minOrderAmount)
  )
    return false;
  if (c.keywords?.length && !hasKeyword(facts.text, c.keywords)) return false;
  if (c.requesterTypes?.length && !c.requesterTypes.includes(facts.requesterType)) return false;
  return true;
}

/** `rules` must already be active and sorted by sortOrder. */
export function decidePriority(
  rules: readonly PriorityRule[],
  facts: TicketFacts,
  topic: { defaultPriority: Priority; team: Team },
): PriorityDecision {
  const rule = rules.find((r) => matches(r, facts));
  if (rule === undefined)
    return { priority: topic.defaultPriority, reason: null, team: topic.team, ruleId: null };
  return {
    priority: rule.priority,
    reason: rule.reasonLabel,
    team: rule.team ?? topic.team,
    ruleId: rule.id,
  };
}
