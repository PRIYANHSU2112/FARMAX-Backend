import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, AUTH_CUSTOMER, AUTH_EXPERT, IDS, ok } from '../../docs/shared.js';
import { CHANNELS } from '../options/index.js';
import { EXPERT_TYPES } from './experts.types.js';

export const ADMIN_EXPERTS_TAG = 'Admin Call Experts';
export const EXPERT_SELF_TAG = 'Call Expert (self)';
export const CALLS_TAG = 'Calls';

const card = {
  id: Joi.string().guid(),
  type: Joi.string().valid(...EXPERT_TYPES),
  displayName: Joi.string().example('Dr. M. K. Rao'),
  title: Joi.string().allow(null).example('Poultry Biologicals Consultant'),
  qualification: Joi.string().allow(null).example('DVM'),
  photoUrl: Joi.string().allow(null),
  experienceYears: Joi.number().integer().allow(null).example(9),
  languages: Joi.array().items(Joi.string()).example(['en', 'hi']),
  ratingAvg: Joi.number().allow(null).example(4.8),
  onTimePct: Joi.number().integer().allow(null).example(98),
};

const expertSchema = Joi.object({
  ...card,
  userId: Joi.string().guid(),
  brandIds: Joi.array().items(Joi.string().guid()).description('Brand reps match these first'),
  categoryIds: Joi.array().items(Joi.string().guid()).description('Any level; matches the product path'),
  productionTypes: Joi.array().items(Joi.string()),
  territoryCodes: Joi.array().items(Joi.string()).description('Farm territories served (farm visits)'),
  channels: Joi.array().items(Joi.string().valid(...CHANNELS)),
  maxPerDay: Joi.number().integer(),
  priority: Joi.number().integer(),
  isBookable: Joi.boolean().description('VET is always false'),
  isActive: Joi.boolean(),
  version: Joi.number().integer().description('Send as `If-Match` on PATCH'),
  createdAt: Joi.date().iso(),
  updatedAt: Joi.date().iso(),
}).meta({ className: 'CallExpert' });

const ruleSchema = Joi.object({
  id: Joi.string().guid(),
  weekday: Joi.number().integer().min(0).max(6).description('0 = Sunday'),
  startMinute: Joi.number().integer().example(540).description('IST minutes from midnight (540 = 09:00)'),
  endMinute: Joi.number().integer().example(780),
  channels: Joi.array().items(Joi.string().valid(...CHANNELS)).description('Empty = all of the expert\'s channels'),
  validFrom: Joi.string().allow(null).example('2026-12-01'),
  validTo: Joi.string().allow(null),
}).meta({ className: 'CallAvailabilityRule' });

const availabilitySchema = Joi.object({
  rules: Joi.array().items(ruleSchema),
  breaks: Joi.array().items(
    Joi.object({
      id: Joi.string().guid(),
      weekday: Joi.number().integer().allow(null).description('null = every day'),
      startMinute: Joi.number().integer(),
      endMinute: Joi.number().integer(),
    }),
  ),
}).meta({ className: 'CallAvailability' });

const expertDetailSchema = expertSchema
  .keys({ rules: Joi.array().items(ruleSchema), breaks: Joi.array().items(Joi.object().unknown(true)) })
  .meta({ className: 'CallExpertDetail' });

const timeOffSchema = Joi.object({
  id: Joi.string().guid(),
  startAt: Joi.date().iso(),
  endAt: Joi.date().iso(),
  reason: Joi.string().allow(null),
  createdByUserId: Joi.string().guid(),
  createdAt: Joi.date().iso(),
}).meta({ className: 'CallTimeOff' });

const holidaySchema = Joi.object({
  id: Joi.string().guid(),
  date: Joi.string().example('2027-01-14'),
  territoryCode: Joi.string().allow(null).description('null = every territory'),
  name: Joi.string().example('Sankranti'),
}).meta({ className: 'CallHoliday' });

const recommendedSchema = Joi.object({
  assignment: Joi.string()
    .valid('RECOMMENDATION_ONLY')
    .description('Advice only: the call is taken by the rep assigned when the slot is held'),
  experts: Joi.array().items(
    Joi.object({
      ...card,
      online: Joi.boolean(),
      isBookable: Joi.boolean().description('May be sent as `preferredExpertId` on a hold'),
      matchedOn: Joi.array().items(Joi.string().valid('BRAND', 'CATEGORY', 'PRODUCTION_TYPE', 'LANGUAGE')),
    }),
  ),
}).meta({ className: 'RecommendedExperts' });

const AVAILABILITY_RULES =
  'Replaces the **whole week** (rules + breaks). Minutes are IST from midnight. Two rules of the same weekday whose date windows meet must not overlap (touching is fine). Rule channels must be ones the expert offers. New availability shows at once; holds already made keep their slot.';

const write = { rateLimit: '60 writes per user per minute' };

export const EXPERT_DOCS = {
  list: {
    tag: ADMIN_EXPERTS_TAG,
    summary: 'List experts',
    description: 'Newest first. Filters: `type`, `isActive`, `isBookable`, `brandId`, `categoryId`, `q` (name).',
    auth: AUTH_ADMIN,
    permission: 'sales.view',
    success: { status: 200, description: 'A page of experts', data: expertSchema, paginated: true },
    errors: [422],
  },
  get: {
    tag: ADMIN_EXPERTS_TAG,
    summary: 'Get an expert (with weekly availability)',
    auth: AUTH_ADMIN,
    permission: 'sales.view',
    success: { status: 200, description: 'Expert', data: expertDetailSchema },
    errors: [404, 422],
  },
  create: {
    tag: ADMIN_EXPERTS_TAG,
    summary: 'Create an expert profile',
    description:
      'Links a staff or vendor login (`userId`, must exist; one profile per user → 409). **VET profiles are never bookable** (shown only as the recommended expert; 422 if `isBookable=true`). Bookable experts need ≥ 1 channel; FARM_VISIT needs ≥ 1 territory. Languages must be LANGUAGE option codes. Audited.',
    auth: AUTH_ADMIN,
    permission: 'sales.configure',
    ...write,
    requestExample: {
      userId: IDS.expertUser,
      type: 'SALES_REP',
      displayName: 'Anil Varma',
      title: 'Area Manager',
      experienceYears: 9,
      languages: ['en', 'hi'],
      brandIds: [IDS.brand],
      territoryCodes: ['WG'],
      channels: ['VIDEO', 'PHONE', 'FARM_VISIT'],
      maxPerDay: 10,
    },
    success: { status: 201, description: 'Created', data: expertSchema },
    errors: [409, 422],
  },
  update: {
    tag: ADMIN_EXPERTS_TAG,
    summary: 'Edit, deactivate or stop bookings for an expert',
    description:
      'Partial update (userId never changes). Send `If-Match: <version>` to avoid overwriting someone else\'s change (409 `VERSION_MISMATCH`). `reason` is required to deactivate (`isActive=false`) or stop bookings (`isBookable=false`). Changing to VET turns bookings off. Availability refreshes at once. Audited.',
    auth: AUTH_ADMIN,
    permission: 'sales.configure',
    ...write,
    headers: { 'If-Match': { description: 'Current `version`', required: false } },
    requestExample: { isBookable: false, reason: 'On field duty until month end' },
    success: { status: 200, description: 'Updated', data: expertSchema },
    errors: [404, 409, 422],
  },
  getAvailability: {
    tag: ADMIN_EXPERTS_TAG,
    summary: 'Get weekly availability',
    auth: AUTH_ADMIN,
    permission: 'sales.view',
    success: { status: 200, description: 'Rules + breaks', data: availabilitySchema },
    errors: [404, 422],
  },
  putAvailability: {
    tag: ADMIN_EXPERTS_TAG,
    summary: 'Replace weekly availability',
    description: `${AVAILABILITY_RULES} Audited.`,
    auth: AUTH_ADMIN,
    permission: 'sales.configure',
    ...write,
    requestExample: {
      rules: [
        { weekday: 1, startMinute: 540, endMinute: 780 },
        { weekday: 1, startMinute: 840, endMinute: 1080, channels: ['VIDEO', 'PHONE'] },
      ],
      breaks: [{ weekday: null, startMinute: 780, endMinute: 840 }],
    },
    success: { status: 200, description: 'Saved', data: availabilitySchema },
    errors: [404, 422],
  },
  listTimeOff: {
    tag: ADMIN_EXPERTS_TAG,
    summary: 'List current and future time-off',
    auth: AUTH_ADMIN,
    permission: 'sales.view',
    success: { status: 200, description: 'Time-off (ending in the future)', data: Joi.array().items(timeOffSchema) },
    errors: [404, 422],
  },
  addTimeOff: {
    tag: ADMIN_EXPERTS_TAG,
    summary: 'Add time-off',
    description: 'Leave, training, field day. Must end in the future; ≤ 90 days. No new holds in the window from now on. Audited.',
    auth: AUTH_ADMIN,
    permission: 'sales.configure',
    ...write,
    requestExample: { startAt: '2026-12-24T03:30:00.000Z', endAt: '2026-12-26T12:30:00.000Z', reason: 'Annual leave' },
    success: { status: 201, description: 'Added', data: timeOffSchema },
    errors: [404, 422],
  },
  removeTimeOff: {
    tag: ADMIN_EXPERTS_TAG,
    summary: 'Remove time-off',
    auth: AUTH_ADMIN,
    permission: 'sales.configure',
    ...write,
    success: { status: 204, description: 'Removed' },
    errors: [404, 422],
  },
  listHolidays: {
    tag: ADMIN_EXPERTS_TAG,
    summary: 'List holidays',
    description: 'Between `from` and `to` (IST dates, ≤ 366 days). A holiday without a territory closes every territory.',
    auth: AUTH_ADMIN,
    permission: 'sales.view',
    success: { status: 200, description: 'Holidays', data: Joi.array().items(holidaySchema) },
    errors: [422],
  },
  addHoliday: {
    tag: ADMIN_EXPERTS_TAG,
    summary: 'Add a holiday',
    description: 'No slots on that IST date (for the territory, or everywhere). Duplicate date + territory → 409. Audited.',
    auth: AUTH_ADMIN,
    permission: 'sales.configure',
    ...write,
    requestExample: { date: '2027-01-14', name: 'Sankranti', territoryCode: null },
    success: { status: 201, description: 'Added', data: holidaySchema },
    errors: [409, 422],
  },
  removeHoliday: {
    tag: ADMIN_EXPERTS_TAG,
    summary: 'Remove a holiday',
    auth: AUTH_ADMIN,
    permission: 'sales.configure',
    ...write,
    success: { status: 204, description: 'Removed' },
    errors: [404, 422],
  },
  // ── self ──
  me: {
    tag: EXPERT_SELF_TAG,
    summary: 'My expert profile',
    description: 'Profile, weekly availability and whether I am currently online.',
    auth: AUTH_EXPERT,
    success: {
      status: 200,
      description: 'Profile',
      data: expertDetailSchema.keys({ online: Joi.boolean() }).meta({ className: 'MyCallExpertProfile' }),
    },
  },
  updateMe: {
    tag: EXPERT_SELF_TAG,
    summary: 'Edit my profile',
    description: 'Title, photo and languages only (skills, channels and territories are set by admins). Audited.',
    auth: AUTH_EXPERT,
    requestExample: { title: 'Area Manager', languages: ['en', 'hi'] },
    success: { status: 200, description: 'Updated', data: expertSchema },
    errors: [422],
  },
  heartbeat: {
    tag: EXPERT_SELF_TAG,
    summary: 'I am online (heartbeat)',
    description: 'Call every 30 s while the expert app is open; online lasts 90 s after the last beat. Drives the "Online" badge.',
    auth: AUTH_EXPERT,
    success: {
      status: 200,
      description: 'Online',
      data: Joi.object({ online: Joi.boolean(), expiresInSeconds: Joi.number().integer() }),
      example: ok({ online: true, expiresInSeconds: 90 }),
    },
  },
  offline: {
    tag: EXPERT_SELF_TAG,
    summary: 'Go offline',
    auth: AUTH_EXPERT,
    success: { status: 204, description: 'Offline' },
  },
  myAvailability: {
    tag: EXPERT_SELF_TAG,
    summary: 'My weekly availability',
    auth: AUTH_EXPERT,
    success: { status: 200, description: 'Rules + breaks', data: availabilitySchema },
  },
  putMyAvailability: {
    tag: EXPERT_SELF_TAG,
    summary: 'Replace my weekly availability',
    description: `${AVAILABILITY_RULES} Audited.`,
    auth: AUTH_EXPERT,
    success: { status: 200, description: 'Saved', data: availabilitySchema },
    errors: [422],
  },
  myTimeOff: {
    tag: EXPERT_SELF_TAG,
    summary: 'My current and future time-off',
    auth: AUTH_EXPERT,
    success: { status: 200, description: 'Time-off', data: Joi.array().items(timeOffSchema) },
  },
  addMyTimeOff: {
    tag: EXPERT_SELF_TAG,
    summary: 'Add my time-off',
    description: 'Must end in the future; ≤ 90 days. Audited.',
    auth: AUTH_EXPERT,
    success: { status: 201, description: 'Added', data: timeOffSchema },
    errors: [422],
  },
  removeMyTimeOff: {
    tag: EXPERT_SELF_TAG,
    summary: 'Remove my time-off',
    auth: AUTH_EXPERT,
    success: { status: 204, description: 'Removed' },
    errors: [404, 422],
  },
  // ── customer ──
  recommended: {
    tag: CALLS_TAG,
    summary: 'Recommended expert for a product',
    description:
      'The expert card above **Continue** on Schedule a Call. Best match for the product (brand rep → category specialist → farm production type → your language), online experts first, then rating and on-time %. **Not linked to the booking**: `assignment` is always `RECOMMENDATION_ONLY`; the call is taken by the rep assigned when the slot is held. `farmId` (your own active farm) adds production-type matching. Presence is live; matches are cached 30 s.',
    auth: AUTH_CUSTOMER,
    rateLimit: '120 per user per minute',
    success: {
      status: 200,
      description: 'Recommended experts (may be empty)',
      data: recommendedSchema,
      example: ok({
        assignment: 'RECOMMENDATION_ONLY',
        experts: [
          {
            id: IDS.expert,
            type: 'VET',
            displayName: 'Dr. M. K. Rao',
            title: 'Poultry Biologicals Consultant',
            qualification: 'DVM',
            photoUrl: null,
            experienceYears: 12,
            languages: ['en', 'hi'],
            ratingAvg: 4.8,
            onTimePct: 98,
            online: true,
            isBookable: false,
            matchedOn: ['CATEGORY', 'PRODUCTION_TYPE'],
          },
        ],
      }),
    },
    errors: [404, 409, 422, 503],
  },
} satisfies Record<string, RouteDocs>;
