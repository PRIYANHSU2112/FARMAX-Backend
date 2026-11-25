import { createHash } from 'node:crypto';

import type {
  HomeContext,
  ItemRow,
  Lang,
  Localized,
  SectionRow,
  Snapshot,
  Targeting,
} from './home.types.js';
import { supportedBy } from './home.widgets.js';

// Pure functions only: no I/O. A snapshot is compiled once per load; every request then filters
// it in memory (Sets, epoch ms, parsed versions), so targeting costs O(sections + items).

export interface CompiledRule {
  platforms?: ReadonlySet<string>;
  userTypes?: ReadonlySet<string>;
  regions?: ReadonlySet<string>;
  excludeRegions?: ReadonlySet<string>;
  farmTypes?: ReadonlySet<string>;
  from?: number;
  until?: number;
  minApp?: readonly number[];
  rollout?: { salt: string; lo: number; hi: number };
  /** ⏳ facts the rule uses that no service provides yet: such a rule never matches. */
  futureFacts: readonly string[];
}

/** Targeting fields with no data source yet (Future). */
export const FUTURE_FACTS = ['flockStages', 'isNewUser', 'hasActiveOrder', 'segments'] as const;

export const futureFactsOf = (t: Targeting | null): string[] =>
  t === null ? [] : FUTURE_FACTS.filter((fact) => t[fact] !== undefined);

/** `1.4` → [1, 4, 0]. Non-numeric parts → 0. */
export const parseVersion = (v: string): number[] => {
  const parts = v.split('.').map((p) => Number.parseInt(p, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
};

export const versionAtLeast = (have: readonly number[], need: readonly number[]): boolean => {
  for (let i = 0; i < 3; i += 1) {
    const h = have[i] ?? 0;
    const n = need[i] ?? 0;
    if (h !== n) return h > n;
  }
  return true;
};

/** Stable 0–99 bucket for A/B and gradual rollout. Same seed + salt → same bucket, always. */
export const bucketOf = (seed: string, salt: string): number =>
  Number.parseInt(createHash('sha1').update(`${salt}:${seed}`).digest('hex').slice(0, 8), 16) % 100;

const setOf = (values: readonly string[] | undefined) =>
  values === undefined ? undefined : new Set(values);

export function compileRule(t: Targeting | null): CompiledRule {
  if (t === null) return { futureFacts: [] };
  const rule: CompiledRule = {
    futureFacts: futureFactsOf(t),
    ...(t.platforms && { platforms: setOf(t.platforms) }),
    ...(t.userTypes && { userTypes: setOf(t.userTypes) }),
    ...(t.regions && { regions: setOf(t.regions) }),
    ...(t.excludeRegions && { excludeRegions: setOf(t.excludeRegions) }),
    ...(t.farmTypes && { farmTypes: setOf(t.farmTypes) }),
    ...(t.activeFrom !== undefined && { from: Date.parse(t.activeFrom) }),
    ...(t.activeUntil !== undefined && { until: Date.parse(t.activeUntil) }),
    ...(t.minAppVersion !== undefined && { minApp: parseVersion(t.minAppVersion) }),
  };
  if (t.rollout !== undefined) {
    const lo = t.rollout.offset ?? 0;
    rule.rollout = { salt: t.rollout.salt, lo, hi: lo + t.rollout.percent };
  }
  return rule;
}

/** What the rules look at, derived once per request from the context. */
export interface RuleFacts {
  platform: string | null;
  userType: string;
  region: string | null;
  farmTypes: readonly string[];
  appVersion: readonly number[] | null;
  /** A/B seed: the device id (stable across login), else the user id, else none. */
  seed: string | null;
  now: number;
}

export const factsOf = (ctx: HomeContext): RuleFacts => ({
  platform: ctx.platform,
  userType: ctx.userType,
  region: ctx.region,
  farmTypes: ctx.farmTypes,
  appVersion: ctx.appVersion === null ? null : parseVersion(ctx.appVersion),
  seed: ctx.deviceId ?? ctx.userId,
  now: ctx.now,
});

/**
 * A missing restriction always passes. A restriction the caller can't satisfy (no platform header,
 * no region, no rollout seed) fails, so targeted content never leaks to unknown callers.
 */
export function matches(rule: CompiledRule, f: RuleFacts): boolean {
  if (rule.futureFacts.length > 0) return false;
  if (rule.platforms && (f.platform === null || !rule.platforms.has(f.platform))) return false;
  if (rule.userTypes && !rule.userTypes.has(f.userType)) return false;
  if (rule.regions && (f.region === null || !rule.regions.has(f.region))) return false;
  if (rule.excludeRegions && f.region !== null && rule.excludeRegions.has(f.region)) return false;
  const farmTypes = rule.farmTypes;
  if (farmTypes && !f.farmTypes.some((t) => farmTypes.has(t))) return false;
  if (rule.from !== undefined && f.now < rule.from) return false;
  if (rule.until !== undefined && f.now >= rule.until) return false;
  if (rule.minApp && (f.appVersion === null || !versionAtLeast(f.appVersion, rule.minApp)))
    return false;
  if (rule.rollout) {
    if (f.seed === null) return false;
    const bucket = bucketOf(f.seed, rule.rollout.salt);
    if (bucket < rule.rollout.lo || bucket >= rule.rollout.hi) return false;
  }
  return true;
}

// ── Compiled snapshot ──

export interface CompiledItem {
  row: ItemRow;
  rule: CompiledRule;
}

export interface CompiledSection {
  row: SectionRow;
  rule: CompiledRule;
  items: CompiledItem[];
}

export interface CompiledSnapshot {
  snap: Snapshot;
  sections: CompiledSection[];
}

export const compileSnapshot = (snap: Snapshot): CompiledSnapshot => ({
  snap,
  sections: [...snap.sections]
    .sort((a, b) => a.displayOrder - b.displayOrder || a.sectionKey.localeCompare(b.sectionKey))
    .map((row) => ({
      row,
      rule: compileRule(row.targeting),
      items: [...row.items]
        .sort((a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id))
        .map((item) => ({ row: item, rule: compileRule(item.targeting) })),
    })),
});

/** Sections this caller sees, in display order (enabled, renderable by the app, targeted). */
export const visibleSections = (
  compiled: CompiledSnapshot,
  facts: RuleFacts,
  sdui: number,
): CompiledSection[] =>
  compiled.sections.filter(
    (s) => s.row.isEnabled && supportedBy(s.row.widgetType, sdui) && matches(s.rule, facts),
  );

/** Items this caller sees (enabled, not broken, targeted), capped at the section's itemLimit. */
export const visibleItems = (section: CompiledSection, facts: RuleFacts): ItemRow[] =>
  section.items
    .filter((i) => i.row.isEnabled && !i.row.refBroken && matches(i.rule, facts))
    .slice(0, section.row.itemLimit)
    .map((i) => i.row);

/** The section's A/B bucket for tracking (only when it has a rollout and a seed). */
export const bucketFor = (section: CompiledSection, facts: RuleFacts): number | undefined =>
  section.rule.rollout === undefined || facts.seed === null
    ? undefined
    : bucketOf(facts.seed, section.rule.rollout.salt);

// ── Text ──

const isLocalized = (value: unknown): value is Localized => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    typeof (value as { en?: unknown }).en === 'string' &&
    keys.every((k) => k === 'en' || k === 'hi')
  );
};

export const localize = (text: Localized | null | undefined, lang: Lang): string | null =>
  text === null || text === undefined ? null : (text[lang] ?? text.en);

/** Replaces every `{ en, hi? }` object inside a config with the caller's language. */
export const localizeDeep = (value: unknown, lang: Lang): unknown => {
  if (isLocalized(value)) return value[lang] ?? value.en;
  if (Array.isArray(value)) return value.map((v) => localizeDeep(v, lang));
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, localizeDeep(v, lang)]));
  return value;
};

/** `Accept-Language: hi-IN,hi;q=0.9,en` → `hi`. Anything else → `en`. */
export const langOf = (header: string | undefined): Lang =>
  header?.trim().toLowerCase().startsWith('hi') === true ? 'hi' : 'en';

/** Stable analytics id: `<page>:<layoutNo>:<sectionKey>[:<itemId>]`. */
export const trackingId = (
  page: string,
  layoutNo: number,
  sectionKey: string,
  itemId?: string,
): string =>
  itemId === undefined
    ? `${page}:${String(layoutNo)}:${sectionKey}`
    : `${page}:${String(layoutNo)}:${sectionKey}:${itemId}`;
