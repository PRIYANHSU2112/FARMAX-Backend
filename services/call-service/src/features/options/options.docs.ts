import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, IDS, ok } from '../../docs/shared.js';
import { SETTING_KEYS } from './options.settings.js';
import { OPTION_TYPES } from './options.types.js';

export const ADMIN_CALL_CONFIG_TAG = 'Admin Call Config';

const optionSchema = Joi.object({
  id: Joi.string().guid(),
  type: Joi.string().valid(...OPTION_TYPES),
  code: Joi.string().example('COMPARE_PRODUCTS'),
  label: Joi.string().example('Compare products'),
  icon: Joi.string().allow(null).example('video'),
  sortOrder: Joi.number().integer(),
  isActive: Joi.boolean(),
  meta: Joi.object()
    .unknown(true)
    .allow(null)
    .description('INTENT / TIMEFRAME: `{ scoreWeight }` used by lead scoring'),
  updatedAt: Joi.date().iso(),
}).meta({ className: 'CallOption' });

const settingSchema = Joi.object({
  key: Joi.string().valid(...SETTING_KEYS),
  value: Joi.any(),
  updatedByUserId: Joi.string().guid().allow(null),
  updatedAt: Joi.date().iso(),
}).meta({ className: 'CallSetting' });

const SETTINGS_HELP = [
  '`slotMinutes` `{VIDEO,PHONE,FARM_VISIT}` 15–240',
  '`bufferMinutes` per channel `{before,after}` 0–240 (blocked around every call; snapshotted per booking)',
  '`minNoticeMinutes` · `horizonDays` · `dateStripDays` · `holdTtlSeconds` (120–1800)',
  '`ackSlaWorkingMinutes` + `businessHours {days[0–6], startMinute, endMinute}` (IST)',
  '`reminderOffsetMinutes` · `reschedule {cutoffMinutes,maxCount,afterFinalDays}`',
  '`attempts {maxAttempts,retryGapMinutes,graceMinutes}` · `noShowLimit {maxNoShows,windowDays,blockDays}`',
  '`leadScoring {sqlMin > mqlMin, valueBands [[minRupees, points]] high→low, routingConsentPoints, intentPoints, maxIntentPoints}`',
  '`consentPolicyVersion` · `retention {heldDays,piiMonths,bookingYears,consentYears,auditYears,attemptYears,recordingDays}`',
  '`whatHappensNext` 1–5 lines; placeholders `{{expert}}` `{{slaHours}}` `{{reminderHours}}`',
].join('\n- ');

export const OPTION_DOCS = {
  list: {
    tag: ADMIN_CALL_CONFIG_TAG,
    summary: 'List booking options (chips)',
    description:
      'Every chip of the booking screens: channels, help intents, buying timeframes, languages, cancel reasons, call dispositions. Includes inactive rows. Filter with `type`.',
    auth: AUTH_ADMIN,
    permission: 'sales.view',
    success: { status: 200, description: 'Options (type, sortOrder)', data: Joi.array().items(optionSchema) },
    errors: [422],
  },
  create: {
    tag: ADMIN_CALL_CONFIG_TAG,
    summary: 'Add a booking option',
    description:
      'New chip. `code` is immutable (UPPER_SNAKE_CASE; LANGUAGE uses ISO codes like `en`). INTENT and TIMEFRAME need `meta.scoreWeight` (0–100). **CHANNEL rows cannot be created** — channels are fixed by the booking engine (422). Audited.',
    auth: AUTH_ADMIN,
    permission: 'sales.configure',
    rateLimit: '60 writes per user per minute',
    requestExample: { type: 'INTENT', code: 'STOCK_AND_DELIVERY', label: 'Stock & delivery date', sortOrder: 5, meta: { scoreWeight: 5 } },
    success: { status: 201, description: 'Created', data: optionSchema },
    errors: [409, 422],
  },
  update: {
    tag: ADMIN_CALL_CONFIG_TAG,
    summary: 'Edit or turn off a booking option',
    description:
      'Label, icon, order, meta, active flag (code and type never change). Turning an option off needs `reason`. The **last active** CHANNEL / LANGUAGE / TIMEFRAME cannot be turned off (409 `LAST_ACTIVE_OPTION`). Turning a channel on/off refreshes availability. Audited.',
    auth: AUTH_ADMIN,
    permission: 'sales.configure',
    rateLimit: '60 writes per user per minute',
    requestExample: { isActive: false, reason: 'Farm visits paused during monsoon' },
    success: {
      status: 200,
      description: 'Updated',
      data: optionSchema,
      example: ok({ id: IDS.option, type: 'CHANNEL', code: 'FARM_VISIT', isActive: false }),
    },
    errors: [404, 409, 422],
  },
  listSettings: {
    tag: ADMIN_CALL_CONFIG_TAG,
    summary: 'List booking rules (settings)',
    description: `Every rule number of the booking flow:\n- ${SETTINGS_HELP}`,
    auth: AUTH_ADMIN,
    permission: 'sales.view',
    success: { status: 200, description: 'Settings', data: Joi.array().items(settingSchema) },
  },
  updateSetting: {
    tag: ADMIN_CALL_CONFIG_TAG,
    summary: 'Change a booking rule',
    description: `Replaces the whole value of one key (validated per key; 422 lists every problem). \`reason\` required; audited. Changes to slot length, buffers, notice or horizon refresh availability at once; **existing bookings keep their buffers** (snapshotted).\n- ${SETTINGS_HELP}`,
    auth: AUTH_ADMIN,
    permission: 'sales.configure',
    rateLimit: '60 writes per user per minute',
    requestExample: { value: { VIDEO: 30, PHONE: 30, FARM_VISIT: 90 }, reason: 'Farm visits need longer slots' },
    success: { status: 200, description: 'Updated', data: settingSchema },
    errors: [422],
  },
} satisfies Record<string, RouteDocs>;
