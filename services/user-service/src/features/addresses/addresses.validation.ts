import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@farmx/database';
import Joi from 'joi';

import { ADDRESS_TYPES } from './addresses.types.js';

export const ID = Joi.string().guid({ version: ['uuidv7', 'uuidv4'] });
const PAGE = {
  cursor: ID,
  limit: Joi.number().integer().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
};

/** `98765 43210` / `9876543210` → `+919876543210`; other countries must send E.164. */
const PHONE = Joi.string()
  .trim()
  .replace(/[\s-]/g, '')
  .replace(/^(?=[6-9]\d{9}$)/, '+91')
  .pattern(/^\+[1-9]\d{7,13}$/)
  .messages({ 'string.pattern.base': 'must be a 10-digit mobile or E.164 (+919876543210)' });
const PIN = Joi.string()
  .trim()
  .pattern(/^[1-9]\d{5}$/)
  .messages({ 'string.pattern.base': 'must be a 6-digit PIN code' });
const STATE = Joi.string()
  .trim()
  .uppercase()
  .pattern(/^[A-Z]{2}$/)
  .messages({ 'string.pattern.base': 'must be a 2-letter state code (TG, AP, KA)' });
const text = (max: number) => Joi.string().trim().min(1).max(max);
const optional = (max: number) =>
  Joi.string().trim().max(max).allow(null, '').empty('').default(null);

const FIELDS = {
  type: Joi.string().valid(...ADDRESS_TYPES),
  label: Joi.string().trim().max(40).allow(null, ''),
  contactName: text(80).min(2),
  contactPhone: PHONE,
  line1: text(150).min(3),
  line2: Joi.string().trim().max(150).allow(null, ''),
  landmark: Joi.string().trim().max(100).allow(null, ''),
  village: Joi.string().trim().max(80).allow(null, ''),
  mandal: Joi.string().trim().max(80).allow(null, ''),
  district: text(80).min(2),
  stateCode: STATE,
  pinCode: PIN,
  latitude: Joi.number().min(-90).max(90).allow(null),
  longitude: Joi.number().min(-180).max(180).allow(null),
};

export const idParamsSchema = { params: Joi.object({ id: ID.required() }) };

export const createSchema = {
  body: Joi.object({
    ...FIELDS,
    type: FIELDS.type.default('HOME'),
    label: optional(40),
    contactName: FIELDS.contactName.required(),
    contactPhone: FIELDS.contactPhone.required(),
    line1: FIELDS.line1.required(),
    line2: optional(150),
    landmark: optional(100),
    village: optional(80),
    mandal: optional(80),
    district: FIELDS.district.required(),
    stateCode: FIELDS.stateCode.required(),
    pinCode: FIELDS.pinCode.required(),
    isDefault: Joi.boolean().default(false),
  })
    .and('latitude', 'longitude')
    .messages({ 'object.and': 'send latitude and longitude together' }),
};

export const updateSchema = {
  params: Joi.object({ id: ID.required() }),
  body: Joi.object(FIELDS)
    .min(1)
    .and('latitude', 'longitude')
    .messages({ 'object.and': 'send latitude and longitude together' }),
};

// ── Admin ──

const USER_ID = Joi.object({ userId: ID.required() });

export const adminListSchema = {
  params: USER_ID,
  querystring: Joi.object({ includeDeleted: Joi.boolean().default(false) }),
};

export const adminHistorySchema = {
  params: Joi.object({ userId: ID.required(), id: ID.required() }),
  querystring: Joi.object(PAGE),
};

// ── Internal ──

export const snapshotSchema = {
  params: Joi.object({ userId: ID.required(), id: ID.required() }),
};

/** `If-Match: 3`, `"3"` or `W/"3"` → 3. Anything else is ignored (no check). */
export const parseIfMatch = (header: string | string[] | undefined): number | undefined => {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/^W\//, '').replaceAll('"', ''));
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};
