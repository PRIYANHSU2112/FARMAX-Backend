import Joi from 'joi';

import { REASON } from '../../middleware/http.js';
import type { SettingKey } from './settings.types.js';

/** The value rules of every key: used for the PATCH body AND for the rows read from the DB. */
export const SETTING_RULES: Record<SettingKey, Joi.Schema> = {
  reservationTtlSeconds: Joi.number().integer().min(60).max(3_600),
  defaultReorderLevel: Joi.number().integer().min(0).max(1_000_000),
  maxReservationLines: Joi.number().integer().min(1).max(200),
  allowSplitAllocation: Joi.boolean(),
};

export const SETTING_KEYS = Object.keys(SETTING_RULES) as SettingKey[];

export const updateSettingsSchema = {
  body: Joi.object({ ...SETTING_RULES, reason: REASON.required() })
    .or(...SETTING_KEYS)
    .messages({ 'object.missing': 'change at least one setting' }),
};
