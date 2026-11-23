import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, IDS } from '../../docs/shared.js';
import { SETTING_KEYS } from './settings.types.js';

export const ADMIN_SUPPORT_CONFIG_TAG = 'Admin Support Config';

const settingSchema = Joi.object({
  key: Joi.string().valid(...SETTING_KEYS),
  value: Joi.object().unknown(true),
  updatedByUserId: Joi.string().guid().allow(null),
  updatedAt: Joi.date().iso().allow(null),
}).meta({ className: 'SupportSetting' });

const calendarSchema = Joi.object({
  id: Joi.string().guid(),
  name: Joi.string().example('Support IST'),
  timezone: Joi.string().example('Asia/Kolkata'),
  weeklyHours: Joi.array().items(
    Joi.object({
      weekday: Joi.number().integer(),
      startMinute: Joi.number().integer(),
      endMinute: Joi.number().integer(),
    }),
  ),
  isActive: Joi.boolean(),
  holidays: Joi.array().items(
    Joi.object({
      id: Joi.string().guid(),
      date: Joi.string().example('2026-12-25'),
      name: Joi.string(),
    }),
  ),
  updatedAt: Joi.date().iso(),
}).meta({ className: 'SupportCalendar' });

const base = { tag: ADMIN_SUPPORT_CONFIG_TAG, auth: AUTH_ADMIN } as const;
const write = {
  ...base,
  permission: 'support.configure',
  rateLimit: '120 writes per user per minute',
} as const;

export const SETTINGS_DOCS = {
  list: {
    ...base,
    permission: 'support.view',
    summary: 'List support settings',
    description:
      '`contacts` (Help & Support card, FAQ "Still have questions?", privacy team) · `limits` (`maxOpenTicketsPerUser`, `autoCloseHours`, `maxAttachmentsPerMessage`) · `chat` (`enabled`, `calendarId`). Missing rows show their defaults.',
    success: { status: 200, description: 'Settings', data: Joi.array().items(settingSchema) },
  },
  update: {
    ...write,
    summary: 'Replace one setting',
    description:
      'Whole value of the key (validated per key) + `reason`. Audited. Caches refresh at once.',
    requestExample: {
      value: { maxOpenTicketsPerUser: 10, autoCloseHours: 72, maxAttachmentsPerMessage: 5 },
      reason: 'Policy update',
    },
    success: {
      status: 200,
      description: 'Saved',
      data: Joi.object({ key: Joi.string(), value: Joi.object().unknown(true) }),
    },
    errors: [422],
  },
  listCalendars: {
    ...base,
    permission: 'support.view',
    summary: 'List business-hours calendars',
    description:
      'Calendars drive SLA clocks: working windows per weekday in an IANA zone, plus holidays.',
    success: { status: 200, description: 'Calendars', data: Joi.array().items(calendarSchema) },
  },
  createCalendar: {
    ...write,
    summary: 'Create a calendar',
    description:
      '`weeklyHours`: windows `{ weekday 0–6 (Sun=0), startMinute, endMinute }` (minutes from local midnight, end ≤ 1440). Several windows per day allowed (lunch breaks). Audited.',
    requestExample: {
      name: 'Support IST',
      timezone: 'Asia/Kolkata',
      weeklyHours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        startMinute: 540,
        endMinute: 1260,
      })),
    },
    success: { status: 201, description: 'Created', data: calendarSchema },
    errors: [409, 422],
  },
  updateCalendar: {
    ...write,
    summary: 'Edit a calendar',
    description:
      'New hours apply to deadlines computed from now on (existing deadlines move only on their next recompute). Audited.',
    success: { status: 200, description: 'Updated', data: calendarSchema },
    errors: [404, 409, 422],
  },
  addHoliday: {
    ...write,
    summary: 'Add a holiday',
    description: 'A local date with no working time. Audited.',
    requestExample: { date: '2026-12-25', name: 'Christmas' },
    success: {
      status: 201,
      description: 'Calendar with holidays',
      data: calendarSchema,
      example: { success: true, data: { id: IDS.calendar } },
    },
    errors: [404, 409, 422],
  },
  deleteHoliday: {
    ...write,
    summary: 'Remove a holiday',
    description: 'Needs `reason`. Audited.',
    requestExample: { reason: 'Declared by mistake' },
    success: { status: 204, description: 'Removed' },
    errors: [404, 422],
  },
} satisfies Record<string, RouteDocs>;
