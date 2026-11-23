import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@farmx/database';
import Joi from 'joi';

/** Joi primitives shared by every warehouse-service feature. */
export const ID = Joi.string().guid({ version: ['uuidv7', 'uuidv4'] });
export const REASON = Joi.string().trim().min(5).max(500);
export const VERSION = Joi.number().integer().min(0);
export const PAGE = {
  cursor: ID,
  limit: Joi.number().integer().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
};
export const idParams = { params: Joi.object({ id: ID.required() }) };
export const PIN_CODE = Joi.string()
  .pattern(/^[1-9][0-9]{5}$/)
  .messages({ 'string.pattern.base': 'must be a 6-digit Indian PIN code' });
/** 2-digit GST state code, e.g. 37 = Andhra Pradesh. */
export const STATE_CODE = Joi.string()
  .pattern(/^\d{2}$/)
  .messages({ 'string.pattern.base': 'must be the 2-digit GST state code, e.g. 37' });
/** District as written by the admin (letters, spaces, dots, hyphens, apostrophes, brackets). */
export const DISTRICT = Joi.string()
  .trim()
  .min(2)
  .max(80)
  .pattern(/^\p{L}[\p{L} .'&()-]*$/u)
  .messages({ 'string.pattern.base': 'must be a district name' });

/** Clock time "HH:mm" (24 h) in the warehouse's timezone. */
export const TIME = Joi.string()
  .pattern(/^([01]\d|2[0-3]):[0-5]\d$/)
  .messages({ 'string.pattern.base': 'must be a 24-hour time HH:mm' });

/** Unique-per-warehouse resource code (zones, racks, bins, doors, slots). */
export const RES_CODE = Joi.string()
  .trim()
  .uppercase()
  .pattern(/^[A-Z0-9][A-Z0-9_-]{0,19}$/)
  .messages({ 'string.pattern.base': 'must be letters, digits, "-" or "_" (max 20)' });

/** Decimal → plain number (limits are far below 2^53). */
export const num = (value: { toString(): string } | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value.toString());
