import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, AUTH_PUBLIC } from '../../docs/shared.js';
import { ADMIN_SUPPORT_CONFIG_TAG } from '../settings/index.js';
import { APPS, PRIORITIES, TEAMS } from '../../middleware/http.js';

export const HELP_TAG = 'Help & Support';

const topicSchema = Joi.object({
  id: Joi.string().guid(),
  app: Joi.string().valid(...APPS),
  code: Joi.string().example('DELIVERY_RETURNS'),
  label: Joi.string().example('Delivery & returns'),
  description: Joi.string().allow(null),
  icon: Joi.string().allow(null),
  sortOrder: Joi.number().integer(),
  defaultPriority: Joi.string().valid(...PRIORITIES),
  team: Joi.string().valid(...TEAMS),
  requiresOrder: Joi.boolean(),
  allowsEvidence: Joi.boolean(),
  isCommonIssue: Joi.boolean(),
  isActive: Joi.boolean(),
  updatedAt: Joi.date().iso(),
}).meta({ className: 'SupportTopic' });

const ruleSchema = Joi.object({
  id: Joi.string().guid(),
  name: Joi.string().example('Cold-chain delivery issue'),
  app: Joi.string()
    .valid(...APPS)
    .allow(null),
  topicCode: Joi.string().allow(null),
  conditions: Joi.object({
    temperatureClasses: Joi.array().items(Joi.string()).example(['CC_REF', 'CC_FRZ']),
    minOrderAmount: Joi.number(),
    keywords: Joi.array().items(Joi.string()).example(['warm', 'melted']),
    requesterTypes: Joi.array().items(Joi.string()),
  }),
  priority: Joi.string().valid(...PRIORITIES),
  reasonLabel: Joi.string().example('cold chain'),
  team: Joi.string()
    .valid(...TEAMS)
    .allow(null),
  sortOrder: Joi.number().integer(),
  isActive: Joi.boolean(),
  updatedAt: Joi.date().iso(),
}).meta({ className: 'SupportPriorityRule' });

const policySchema = Joi.object({
  app: Joi.string().valid(...APPS),
  priority: Joi.string().valid(...PRIORITIES),
  calendarId: Joi.string().guid().allow(null),
  firstResponseMins: Joi.number().integer().example(60),
  resolveMins: Joi.number().integer().example(480),
  businessHoursOnly: Joi.boolean(),
  updatedAt: Joi.date().iso().allow(null),
}).meta({ className: 'SupportSlaPolicy' });

const publicTopic = Joi.object({
  code: Joi.string(),
  label: Joi.string(),
  description: Joi.string().allow(null),
  icon: Joi.string().allow(null),
  requiresOrder: Joi.boolean(),
  allowsEvidence: Joi.boolean(),
  isCommonIssue: Joi.boolean(),
});

const admin = { tag: ADMIN_SUPPORT_CONFIG_TAG, auth: AUTH_ADMIN } as const;
const write = {
  ...admin,
  permission: 'support.configure',
  rateLimit: '120 writes per user per minute',
} as const;

export const TOPIC_DOCS = {
  config: {
    tag: HELP_TAG,
    public: true,
    auth: AUTH_PUBLIC,
    summary: 'Help & Support home config',
    description:
      'Contact card (call, email, WhatsApp, hours, privacy team), live-chat switch, ticket topics (New ticket chips) and Common Issues of one app. Cached; refreshes within seconds of an admin change.',
    success: {
      status: 200,
      description: 'Config',
      data: Joi.object({
        app: Joi.string().valid(...APPS),
        contacts: Joi.object().unknown(true),
        chat: Joi.object({ enabled: Joi.boolean() }),
        limits: Joi.object({ maxAttachmentsPerMessage: Joi.number().integer() }),
        topics: Joi.array().items(publicTopic),
        commonIssues: Joi.array().items(publicTopic),
      }).meta({ className: 'SupportConfig' }),
    },
    errors: [422],
  },
  listTopics: {
    ...admin,
    permission: 'support.view',
    summary: 'List ticket topics',
    description: 'All apps (filter `app`), inactive included.',
    success: { status: 200, description: 'Topics', data: Joi.array().items(topicSchema) },
  },
  createTopic: {
    ...write,
    summary: 'Add a ticket topic',
    description:
      '`code` (UPPER_SNAKE) and `app` never change. `defaultPriority` and `team` apply when no priority rule matches. `requiresOrder` makes the order mandatory. Audited.',
    requestExample: {
      app: 'CUSTOMER',
      code: 'DELIVERY_RETURNS',
      label: 'Delivery & returns',
      defaultPriority: 'MEDIUM',
      team: 'SUPPORT',
      requiresOrder: true,
      isCommonIssue: true,
    },
    success: { status: 201, description: 'Created', data: topicSchema },
    errors: [409, 422],
  },
  updateTopic: {
    ...write,
    summary: 'Edit or turn off a topic',
    description: 'Needs `reason`. Existing tickets keep their topic snapshot. Audited.',
    success: { status: 200, description: 'Updated', data: topicSchema },
    errors: [404, 422],
  },
  listRules: {
    ...admin,
    permission: 'support.view',
    summary: 'List priority rules',
    description:
      'Evaluated in `sortOrder`; the first rule whose every present condition holds sets the priority, its reason label (shown as "High · cold chain") and optionally the team.',
    success: { status: 200, description: 'Rules', data: Joi.array().items(ruleSchema) },
  },
  createRule: {
    ...write,
    summary: 'Add a priority rule',
    description:
      'Conditions (all optional, all present must hold): `temperatureClasses` (any order line), `minOrderAmount` (₹ grand total), `keywords` (whole words in the ticket text), `requesterTypes`. Scope with `app` / `topicCode` (null = any). Audited.',
    requestExample: {
      name: 'Cold-chain delivery issue',
      topicCode: 'DELIVERY_RETURNS',
      conditions: { temperatureClasses: ['CC_REF', 'CC_FRZ'] },
      priority: 'HIGH',
      reasonLabel: 'cold chain',
      sortOrder: 10,
    },
    success: { status: 201, description: 'Created', data: ruleSchema },
    errors: [422],
  },
  updateRule: {
    ...write,
    summary: 'Edit or turn off a priority rule',
    description: 'Needs `reason`. Applies to new tickets only. Audited.',
    success: { status: 200, description: 'Updated', data: ruleSchema },
    errors: [404, 422],
  },
  listPolicies: {
    ...admin,
    permission: 'support.view',
    summary: 'List SLA policies',
    description: 'Every app × priority cell (unsaved cells show wall-clock defaults).',
    success: { status: 200, description: 'Policies', data: Joi.array().items(policySchema) },
  },
  savePolicy: {
    ...write,
    summary: 'Set the SLA of an app + priority',
    description:
      "First-response and resolution targets in minutes. `businessHoursOnly` counts only the calendar's working time (skips nights, closed days, holidays) and needs `calendarId`. New tickets and priority changes use it; existing deadlines are kept. Audited.",
    requestExample: {
      calendarId: null,
      firstResponseMins: 60,
      resolveMins: 480,
      businessHoursOnly: false,
      reason: 'Tighter cold-chain SLA',
    },
    success: { status: 200, description: 'Saved', data: policySchema },
    errors: [422],
  },
} satisfies Record<string, RouteDocs>;
