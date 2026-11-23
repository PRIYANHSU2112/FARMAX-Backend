/**
 * Pure PIN helpers (no I/O; unit-tested). Admins type single PINs ("411001") or ranges
 * ("411001-411045"); a range stays inside one sorting district (same first 3 digits) and covers at
 * most MAX_RANGE PINs, so a typo cannot add half of India.
 */
export const MAX_RANGE = 1_000;
/** One warehouse serves at most this many PINs (the coverage event carries the full list). */
export const MAX_PINS_PER_WAREHOUSE = 5_000;

export const PIN_OR_RANGE = /^[1-9]\d{5}(-[1-9]\d{5})?$/;

export interface PinParseIssue {
  entry: string;
  message: string;
}

/** Expands entries into sorted, unique PINs, or lists every invalid entry. */
export function expandPins(entries: readonly string[]): {
  pins: string[];
  issues: PinParseIssue[];
} {
  const out = new Set<string>();
  const issues: PinParseIssue[] = [];
  for (const raw of entries) {
    const entry = raw.replace(/\s+/g, '');
    if (!PIN_OR_RANGE.test(entry)) {
      issues.push({ entry: raw, message: 'must be a 6-digit PIN or a range like 411001-411045' });
      continue;
    }
    const [from = '', to = from] = entry.split('-');
    const start = Number(from);
    const end = Number(to);
    if (end < start) {
      issues.push({ entry: raw, message: 'the range ends before it starts' });
      continue;
    }
    if (from.slice(0, 3) !== to.slice(0, 3)) {
      issues.push({
        entry: raw,
        message: 'a range must stay within one PIN area (same first 3 digits)',
      });
      continue;
    }
    if (end - start + 1 > MAX_RANGE) {
      issues.push({ entry: raw, message: `a range may cover at most ${MAX_RANGE} PINs` });
      continue;
    }
    for (let pin = start; pin <= end; pin += 1) out.add(String(pin));
  }
  return { pins: [...out].sort(), issues };
}

/** Sorted PINs → compact ranges for display ("411001–411045", "411050"). */
export function compressPins(pins: readonly string[]): string[] {
  const sorted = [...new Set(pins)].sort();
  const ranges: string[] = [];
  let start: string | undefined;
  let prev = -2;
  for (const pin of sorted) {
    const n = Number(pin);
    if (start !== undefined && n === prev + 1) {
      prev = n;
      continue;
    }
    if (start !== undefined)
      ranges.push(Number(start) === prev ? start : `${start}-${String(prev)}`);
    start = pin;
    prev = n;
  }
  if (start !== undefined) ranges.push(Number(start) === prev ? start : `${start}-${String(prev)}`);
  return ranges;
}
