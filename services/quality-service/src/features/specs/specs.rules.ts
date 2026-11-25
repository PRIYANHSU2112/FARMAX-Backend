/**
 * Pure quality rules (D-60): judging a measured value against a SKU limit, a COA's overall
 * verdict, manufacturer-vs-independent mismatch and the spec form checks. No I/O.
 */

export type SpecRule = 'MIN' | 'MAX' | 'RANGE' | 'TEXT';
export type ParamVerdict = 'CONFORMS' | 'FAILS' | 'REVIEW';
export type CoaVerdict = 'PENDING' | 'PASS' | 'FAIL';

export interface SpecParam {
  code: string;
  name: string;
  unit: string | null;
  rule: SpecRule;
  min: number | null;
  max: number | null;
  expectedText: string | null;
  critical: boolean;
  sortOrder: number;
}

export interface Measured {
  valueNum?: number | null;
  valueText?: string | null;
}

/** Floating-point tolerance at the limit (12.0 ≤ 12 must conform). */
const EPS = 1e-9;

/**
 * One parameter: CONFORMS within the limit, FAILS outside it, REVIEW when there is no usable
 * value yet (e.g. "Sterility: pending review"). Log values (virus titre 10^5.8) are entered as
 * the exponent (5.8) against a MIN of 6.0.
 */
export function judge(p: SpecParam, m: Measured): ParamVerdict {
  if (p.rule === 'TEXT') {
    const text = m.valueText?.trim();
    if (text === undefined || text === '') return 'REVIEW';
    return text.toLowerCase() === (p.expectedText ?? '').trim().toLowerCase()
      ? 'CONFORMS'
      : 'FAILS';
  }
  const v = m.valueNum;
  if (v === null || v === undefined || !Number.isFinite(v)) return 'REVIEW';
  if ((p.rule === 'MIN' || p.rule === 'RANGE') && p.min !== null && v < p.min - EPS) return 'FAILS';
  if ((p.rule === 'MAX' || p.rule === 'RANGE') && p.max !== null && v > p.max + EPS) return 'FAILS';
  return 'CONFORMS';
}

/**
 * Whole certificate: any FAILS → FAIL; every spec parameter judged CONFORMS → PASS; otherwise
 * PENDING (missing or REVIEW parameters).
 */
export function overallVerdict(
  specCodes: readonly string[],
  results: readonly { paramCode: string; verdict: ParamVerdict }[],
): CoaVerdict {
  if (results.some((r) => r.verdict === 'FAILS')) return 'FAIL';
  const byCode = new Map(results.map((r) => [r.paramCode, r.verdict]));
  if (specCodes.length === 0) return 'PENDING';
  return specCodes.every((c) => byCode.get(c) === 'CONFORMS') ? 'PASS' : 'PENDING';
}

const num = (v: number): string => String(Number(v.toFixed(6)));

/** Human label of a limit: "≥ 85 %", "≤ 10 ppm", "7.0–9.0", "Conforms". */
export function specLabel(
  p: Pick<SpecParam, 'rule' | 'min' | 'max' | 'expectedText' | 'unit'>,
): string {
  const unit = p.unit === null || p.unit === '' ? '' : ` ${p.unit}`;
  switch (p.rule) {
    case 'MIN':
      return `≥ ${num(p.min ?? 0)}${unit}`;
    case 'MAX':
      return `≤ ${num(p.max ?? 0)}${unit}`;
    case 'RANGE':
      return `${num(p.min ?? 0)}–${num(p.max ?? 0)}${unit}`;
    case 'TEXT':
      return p.expectedText ?? '';
  }
}

export interface MismatchParam {
  code: string;
  name: string;
  critical: boolean;
}

/**
 * Certificate Audit Alert: parameters the manufacturer declared CONFORMS that the independent
 * lab found FAILS. HIGH when any of them is critical (or ≥ 2 parameters), else MEDIUM.
 */
export function mismatch(
  manufacturer: readonly { paramCode: string; verdict: ParamVerdict }[],
  independent: readonly {
    paramCode: string;
    paramName: string;
    verdict: ParamVerdict;
    critical: boolean;
  }[],
): { severity: 'HIGH' | 'MEDIUM'; params: MismatchParam[] } | null {
  const mfr = new Map(manufacturer.map((r) => [r.paramCode, r.verdict]));
  const params = independent
    .filter((r) => r.verdict === 'FAILS' && mfr.get(r.paramCode) === 'CONFORMS')
    .map((r) => ({ code: r.paramCode, name: r.paramName, critical: r.critical }));
  if (params.length === 0) return null;
  return {
    severity: params.some((p) => p.critical) || params.length >= 2 ? 'HIGH' : 'MEDIUM',
    params,
  };
}

/** Spec form problems (empty = valid). Paths match the request body. */
export function specProblems(
  params: readonly Omit<SpecParam, 'sortOrder'>[],
  isActive: boolean,
): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  if (isActive && params.length === 0)
    out.push({
      path: 'body.params',
      message: 'an active specification needs at least one parameter',
    });
  const seen = new Set<string>();
  params.forEach((p, i) => {
    const at = `body.params[${i}]`;
    if (seen.has(p.code))
      out.push({ path: `${at}.code`, message: `duplicate parameter "${p.code}"` });
    seen.add(p.code);
    if ((p.rule === 'MIN' || p.rule === 'RANGE') && p.min === null)
      out.push({ path: `${at}.min`, message: `${p.rule} needs min` });
    if ((p.rule === 'MAX' || p.rule === 'RANGE') && p.max === null)
      out.push({ path: `${at}.max`, message: `${p.rule} needs max` });
    if (p.rule === 'RANGE' && p.min !== null && p.max !== null && p.min > p.max)
      out.push({ path: `${at}.max`, message: 'max must be ≥ min' });
    if (p.rule === 'TEXT' && (p.expectedText ?? '').trim() === '')
      out.push({ path: `${at}.expectedText`, message: 'TEXT needs expectedText' });
  });
  return out;
}
