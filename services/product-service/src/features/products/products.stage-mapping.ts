/**
 * Legacy `productionStages` free text → FLOCK_STAGE codes (used by scripts/map-production-stages.ts).
 * Pure functions: the mapping table comes from the live FLOCK_STAGE lookups (code, label,
 * meta.aliases), so admins fix unmapped values by adding an alias — no code change.
 */

export interface StageLookup {
  code: string;
  label: string;
  aliases: string[];
}

/** trim, lower-case, `_` / `-` / `/` and repeated spaces → one space. */
export const normalizeStage = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[_\-/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Index of every accepted spelling → code. Match order: code, then label, then aliases (an
 * earlier kind wins when two stages share a spelling).
 */
export const buildStageIndex = (stages: readonly StageLookup[]): Map<string, string> => {
  const index = new Map<string, string>();
  const add = (spelling: string, code: string) => {
    const key = normalizeStage(spelling);
    if (key !== '' && !index.has(key)) index.set(key, code);
  };
  for (const s of stages) add(s.code, s.code);
  for (const s of stages) add(s.label, s.code);
  for (const s of stages) for (const alias of s.aliases) add(alias, s.code);
  return index;
};

export interface StageMappingResult {
  /** Codes to store (mapped values + untouched unmapped values, de-duplicated, order kept). */
  next: string[];
  /** Original values that matched nothing (left as-is for a manual edit). */
  unmapped: string[];
  changed: boolean;
}

export const mapStages = (
  values: readonly string[],
  index: ReadonlyMap<string, string>,
  validCodes: ReadonlySet<string>,
): StageMappingResult => {
  const next: string[] = [];
  const unmapped: string[] = [];
  for (const value of values) {
    const code = validCodes.has(value) ? value : index.get(normalizeStage(value));
    if (code === undefined) unmapped.push(value);
    const out = code ?? value;
    if (!next.includes(out)) next.push(out);
  }
  const changed = next.length !== values.length || next.some((v, i) => v !== values[i]);
  return { next, unmapped, changed };
};
