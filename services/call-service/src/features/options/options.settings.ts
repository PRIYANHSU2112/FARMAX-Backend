import Joi from 'joi';

/** Booking channels (enum `CallChannel`); CHANNEL option codes are exactly these. */
export const CHANNELS = ['VIDEO', 'PHONE', 'FARM_VISIT'] as const;
export type Channel = (typeof CHANNELS)[number];

type PerChannel<T> = Record<Channel, T>;

/** Every business rule of call-service: one `call_settings` row per key (D-53). */
export interface CallSettings {
  /** Slot length per channel (also the grid step). */
  slotMinutes: PerChannel<number>;
  /** Blocked before / after each call (travel for farm visits); snapshotted on the booking. */
  bufferMinutes: PerChannel<{ before: number; after: number }>;
  minNoticeMinutes: number;
  horizonDays: number;
  /** Days in the date strip on screen 1. */
  dateStripDays: number;
  holdTtlSeconds: number;
  /** Rep must acknowledge within this many WORKING minutes (business hours below). */
  ackSlaWorkingMinutes: number;
  /** FarmX working hours (IST): weekdays 0 = Sunday … 6 = Saturday. */
  businessHours: { days: number[]; startMinute: number; endMinute: number };
  reminderOffsetMinutes: number;
  reschedule: { cutoffMinutes: number; maxCount: number; afterFinalDays: number };
  attempts: { maxAttempts: number; retryGapMinutes: number; graceMinutes: number };
  noShowLimit: { maxNoShows: number; windowDays: number; blockDays: number };
  /** valueBands: [minOrderValueRupees, points] sorted high → low. */
  leadScoring: {
    sqlMin: number;
    mqlMin: number;
    valueBands: [number, number][];
    routingConsentPoints: number;
    intentPoints: number;
    maxIntentPoints: number;
  };
  consentPolicyVersion: string;
  retention: {
    heldDays: number;
    piiMonths: number;
    bookingYears: number;
    consentYears: number;
    auditYears: number;
    attemptYears: number;
    recordingDays: number;
  };
  /** "What happens next" lines; placeholders {{expert}} {{slaHours}} {{reminderHours}}. */
  whatHappensNext: string[];
}

export type SettingKey = keyof CallSettings;

const int = (min: number, max: number) => Joi.number().integer().min(min).max(max).required();
const perChannel = (schema: Joi.Schema) =>
  Joi.object(Object.fromEntries(CHANNELS.map((c) => [c, schema]))).required();
const minuteOfDay = int(0, 1440);

/** Validation per key. Cross-field rules (e.g. sqlMin > mqlMin) live in `checkSetting`. */
export const SETTING_RULES: Record<SettingKey, Joi.Schema> = {
  slotMinutes: perChannel(int(15, 240)),
  bufferMinutes: perChannel(Joi.object({ before: int(0, 240), after: int(0, 240) })),
  minNoticeMinutes: int(0, 10_080),
  horizonDays: int(1, 90),
  dateStripDays: int(3, 14),
  holdTtlSeconds: int(120, 1_800),
  ackSlaWorkingMinutes: int(15, 2_880),
  businessHours: Joi.object({
    days: Joi.array().items(int(0, 6)).min(1).max(7).unique().required(),
    startMinute: minuteOfDay,
    endMinute: minuteOfDay,
  }).required(),
  reminderOffsetMinutes: int(5, 1_440),
  reschedule: Joi.object({
    cutoffMinutes: int(0, 1_440),
    maxCount: int(0, 10),
    afterFinalDays: int(0, 30),
  }).required(),
  attempts: Joi.object({
    maxAttempts: int(1, 5),
    retryGapMinutes: int(1, 30),
    graceMinutes: int(5, 60),
  }).required(),
  noShowLimit: Joi.object({
    maxNoShows: int(1, 10),
    windowDays: int(1, 90),
    blockDays: int(0, 30),
  }).required(),
  leadScoring: Joi.object({
    sqlMin: int(1, 100),
    mqlMin: int(0, 99),
    valueBands: Joi.array()
      .items(Joi.array().ordered(int(0, 100_000_000), int(0, 100)).length(2))
      .min(1)
      .max(10)
      .required(),
    routingConsentPoints: int(0, 50),
    intentPoints: int(0, 50),
    maxIntentPoints: int(0, 100),
  }).required(),
  consentPolicyVersion: Joi.string().trim().min(1).max(20).required(),
  retention: Joi.object({
    heldDays: int(1, 365),
    piiMonths: int(1, 120),
    bookingYears: int(1, 15),
    consentYears: int(1, 15),
    auditYears: int(1, 15),
    attemptYears: int(1, 15),
    recordingDays: int(1, 3_650),
  }).required(),
  whatHappensNext: Joi.array().items(Joi.string().trim().min(3).max(160)).min(1).max(5).required(),
};

export const SETTING_KEYS = Object.keys(SETTING_RULES) as SettingKey[];

/**
 * Validates one setting value (shape + cross-field rules). Returns the normalised value or the
 * list of problems (paths relative to `value`).
 */
export const checkSetting = (
  key: SettingKey,
  value: unknown,
): { value: unknown; issues: { path: string; message: string }[] } => {
  const result: Joi.ValidationResult<unknown> = SETTING_RULES[key].validate(value, {
    abortEarly: false,
    convert: false,
  });
  const v: unknown = result.value;
  const error = result.error;
  const issues =
    error?.details.map((d) => ({ path: ['value', ...d.path].join('.'), message: d.message })) ?? [];
  if (issues.length > 0) return { value: v, issues };
  if (key === 'businessHours') {
    const bh = v as CallSettings['businessHours'];
    if (bh.startMinute >= bh.endMinute)
      issues.push({ path: 'value.endMinute', message: 'endMinute must be after startMinute' });
  }
  if (key === 'leadScoring') {
    const ls = v as CallSettings['leadScoring'];
    if (ls.sqlMin <= ls.mqlMin)
      issues.push({ path: 'value.sqlMin', message: 'sqlMin must be greater than mqlMin' });
    const mins = ls.valueBands.map(([min]) => min);
    if (mins.some((m, i) => i > 0 && m >= (mins[i - 1] ?? 0)))
      issues.push({ path: 'value.valueBands', message: 'valueBands must be sorted by value, high → low' });
  }
  return { value: v, issues };
};

/** Reads every row into a typed object; a missing / invalid row is a deploy bug (throws). */
export const parseSettings = (rows: readonly { key: string; value: unknown }[]): CallSettings => {
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    const { value, issues } = checkSetting(key, byKey.get(key));
    if (issues.length > 0) throw new Error(`call setting "${key}" is missing or invalid`);
    out[key] = value;
  }
  return out as unknown as CallSettings;
};
