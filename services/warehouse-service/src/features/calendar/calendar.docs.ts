import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { IF_VERSION, staffDoc } from '../../docs/shared.js';

export const ADMIN_CALENDAR_TAG = 'Admin Warehouse Calendar';

const T = ADMIN_CALENDAR_TAG;
const conf = 'warehouse.configure';

const shift = Joi.object({
  id: Joi.string().guid(),
  name: Joi.string().example('Morning Shift'),
  startsAt: Joi.string().example('06:00'),
  endsAt: Joi.string().example('14:00'),
  overnight: Joi.boolean(),
  breakStartsAt: Joi.string().allow(null).example('12:00'),
  breakEndsAt: Joi.string().allow(null).example('12:30'),
  isoDays: Joi.array().items(Joi.number().integer()).example([1, 2, 3, 4, 5, 6]),
  teamName: Joi.string().allow(null).example('Picking Team A'),
  dockDoorIds: Joi.array().items(Joi.string().guid()),
  status: Joi.string(),
  version: Joi.number().integer(),
}).meta({ className: 'WarehouseShift' });

const holiday = Joi.object({
  id: Joi.string().guid(),
  date: Joi.string().example('2027-01-26'),
  name: Joi.string().example('Republic Day'),
  reason: Joi.string().allow(null),
  mode: Joi.string().valid('CLOSED', 'LIMITED'),
  limitedFrom: Joi.string().allow(null),
  limitedTo: Joi.string().allow(null),
}).meta({ className: 'WarehouseHoliday' });

const calendar = Joi.object({
  warehouseId: Joi.string().guid(),
  timezone: Joi.string(),
  today: Joi.object().description("Today's hours after holidays, shifts working today"),
  operatingHours: Joi.array().items(Joi.object()),
  cutoffs: Joi.array().items(Joi.object()),
  shifts: Joi.array().items(shift),
  holidays: Joi.array().items(holiday),
  upcomingHolidays: Joi.object(),
}).meta({ className: 'WarehouseCalendar' });

export const CALENDAR_DOCS = {
  get: staffDoc(T, 'Operating calendar & shifts (W2.09)', 'warehouse.view', {
    data: calendar,
    description:
      "One call for the screen: today's hours and shifts, weekly grid, order cut-offs, shifts, holidays from today on. Times are HH:mm in the warehouse timezone.",
  }),
  hours: staffDoc(T, 'Edit weekly working hours', conf, {
    data: calendar,
    description: 'All 7 days; an open day needs opening before closing.',
  }),
  cutoffs: staffDoc(T, 'Edit order cut-off times', conf, {
    data: calendar,
    description: 'Same-day standard, same-day cold chain, next-day dispatch (null removes one).',
  }),
  createShift: staffDoc(T, 'Add shift', conf, {
    status: 201,
    data: shift,
    errors: [404, 409, 422],
    description: 'The break must fall inside the shift; an overnight shift ends the next day.',
  }),
  updateShift: staffDoc(T, 'Edit shift', conf, {
    data: shift,
    errors: [404, 409, 422],
    description: IF_VERSION,
  }),
  deleteShift: staffDoc(T, 'Delete shift', conf, { status: 204 }),
  createHoliday: staffDoc(T, 'Add holiday', conf, {
    status: 201,
    data: holiday,
    errors: [404, 409, 422],
    description: 'CLOSED, or LIMITED with the hours it still works. One per date.',
  }),
  updateHoliday: staffDoc(T, 'Edit holiday', conf, { data: holiday, errors: [404, 409, 422] }),
  deleteHoliday: staffDoc(T, 'Delete holiday', conf, { status: 204 }),
} satisfies Record<string, RouteDocs>;
