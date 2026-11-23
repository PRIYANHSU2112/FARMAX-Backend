import Joi from 'joi';

import { ID, TIME, VERSION } from '../../middleware/http.js';
import { CUTOFF_TYPES } from './calendar.types.js';

const wh = { id: ID.required() };
const DATE = Joi.string()
  .pattern(/^\d{4}-\d{2}-\d{2}$/)
  .messages({ 'string.pattern.base': 'must be a date YYYY-MM-DD' });
const DAYS = Joi.array().items(Joi.number().integer().min(1).max(7)).min(1).max(7).unique();

export const calendarSchema = { params: Joi.object(wh) };

export const hoursSchema = {
  params: Joi.object(wh),
  body: Joi.object({
    days: Joi.array()
      .items(
        Joi.object({
          isoDay: Joi.number().integer().min(1).max(7).required(),
          isOpen: Joi.boolean().required(),
          opensAt: TIME.allow(null).default(null),
          closesAt: TIME.allow(null).default(null),
        }),
      )
      .length(7)
      .required()
      .description('All 7 weekdays (1 = Monday … 7 = Sunday)'),
  }),
};

export const cutoffsSchema = {
  params: Joi.object(wh),
  body: Joi.object({
    cutoffs: Joi.array()
      .items(
        Joi.object({
          type: Joi.string()
            .valid(...CUTOFF_TYPES)
            .required(),
          cutoffTime: TIME.allow(null).required().description('null = no cut-off of this type'),
        }),
      )
      .min(1)
      .max(3)
      .unique('type')
      .required(),
  }),
};

const shiftFields = {
  name: Joi.string().trim().min(1).max(60),
  startsAt: TIME,
  endsAt: TIME,
  overnight: Joi.boolean(),
  breakStartsAt: TIME.allow(null),
  breakEndsAt: TIME.allow(null),
  isoDays: DAYS,
  teamName: Joi.string().trim().max(60).allow(null, ''),
  dockDoorIds: Joi.array().items(ID).max(50).unique(),
  status: Joi.string().valid('ACTIVE', 'INACTIVE'),
};

export const createShiftSchema = {
  params: Joi.object(wh),
  body: Joi.object({
    ...shiftFields,
    name: shiftFields.name.required(),
    startsAt: shiftFields.startsAt.required(),
    endsAt: shiftFields.endsAt.required(),
    isoDays: shiftFields.isoDays.required(),
  }),
};

export const updateShiftSchema = {
  params: Joi.object({ ...wh, shiftId: ID.required() }),
  body: Joi.object({ ...shiftFields, expectedVersion: VERSION.required() }).or(
    ...Object.keys(shiftFields),
  ),
};

export const shiftParams = { params: Joi.object({ ...wh, shiftId: ID.required() }) };

const holidayFields = {
  date: DATE,
  name: Joi.string().trim().min(1).max(80),
  reason: Joi.string().trim().max(200).allow(null, ''),
  mode: Joi.string().valid('CLOSED', 'LIMITED'),
  limitedFrom: TIME.allow(null),
  limitedTo: TIME.allow(null),
};

export const createHolidaySchema = {
  params: Joi.object(wh),
  body: Joi.object({
    ...holidayFields,
    date: holidayFields.date.required(),
    name: holidayFields.name.required(),
    mode: holidayFields.mode.required(),
  }),
};

export const updateHolidaySchema = {
  params: Joi.object({ ...wh, holidayId: ID.required() }),
  body: Joi.object(holidayFields).or(...Object.keys(holidayFields)),
};

export const holidayParams = { params: Joi.object({ ...wh, holidayId: ID.required() }) };
