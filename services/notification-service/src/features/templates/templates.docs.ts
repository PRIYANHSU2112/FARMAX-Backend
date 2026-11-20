import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, IDS, ok } from '../../docs/shared.js';
import { CHANNELS } from '../../domain.js';

export const TEMPLATES_TAG = 'Admin Notification Templates';

const variable = Joi.object({
  name: Joi.string().example('orderNo'),
  type: Joi.string().valid('string', 'number', 'money', 'date'),
  required: Joi.boolean(),
  maxLength: Joi.number().integer(),
}).meta({ className: 'TemplateVariable' });

const template = Joi.object({
  id: Joi.string().guid(),
  key: Joi.string().example('order.confirmed'),
  channel: Joi.string().valid(...CHANNELS),
  locale: Joi.string().example('en'),
  version: Joi.number().integer(),
  title: Joi.string().allow(null).description('In-app / push title or email subject'),
  body: Joi.string().description('Text with `{{variable}}` placeholders'),
  htmlBody: Joi.string()
    .allow(null)
    .description('Email HTML (values are HTML-escaped). Null = generated from body'),
  variables: Joi.array().items(variable),
  description: Joi.string().allow(null),
  isActive: Joi.boolean(),
  createdBy: Joi.string().guid().allow(null),
  createdAt: Joi.date().iso(),
}).meta({ className: 'NotificationTemplate' });

const example = {
  id: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7c01',
  key: 'order.confirmed',
  channel: 'EMAIL',
  locale: 'en',
  version: 2,
  title: 'Order {{orderNo}} confirmed',
  body: 'Hello,\n\nYour order {{orderNo}} is confirmed and is being prepared for dispatch.\n\nFarmX',
  htmlBody: null,
  variables: [{ name: 'orderNo', type: 'string', maxLength: 40 }],
  description: 'Buyer: admin confirmed the order',
  isActive: true,
  createdBy: IDS.user,
  createdAt: '2026-11-24T10:15:00.000Z',
};

const RULES =
  'A family is (key, channel, locale); exactly one version is active and is cached for up to 60 s per replica. PUSH falls back to the IN_APP template. Placeholders: `{{name}}` only (no logic); every placeholder must be a declared variable (422).';

export const TEMPLATE_DOCS = {
  list: {
    tag: TEMPLATES_TAG,
    summary: 'List templates (all versions)',
    description: RULES,
    operationId: 'listNotificationTemplates',
    auth: AUTH_ADMIN,
    permission: 'notifications.view',
    success: {
      status: 200,
      description: 'Versions, newest first per family',
      data: template,
      example: ok([example]),
    },
    errors: [422],
  },
  get: {
    tag: TEMPLATES_TAG,
    summary: 'One template version',
    operationId: 'getNotificationTemplate',
    auth: AUTH_ADMIN,
    permission: 'notifications.view',
    success: { status: 200, description: 'Template', data: template, example: ok(example) },
    errors: [404, 422],
  },
  create: {
    tag: TEMPLATES_TAG,
    summary: 'Create a template family (version 1, active)',
    description: `${RULES} Use it for a new key or a new channel / language of an existing key. \`reason\` required; audited.`,
    operationId: 'createNotificationTemplate',
    auth: AUTH_ADMIN,
    permission: 'notifications.manage',
    rateLimit: '30 writes per user per minute',
    requestExample: {
      key: 'farm.visit_scheduled',
      channel: 'IN_APP',
      locale: 'en',
      title: 'Vet visit on {{visitDate}}',
      body: 'Dr. {{vetName}} will visit your farm on {{visitDate}}.',
      variables: [
        { name: 'vetName', type: 'string', maxLength: 60 },
        { name: 'visitDate', type: 'date' },
      ],
      reason: 'New vet-visit reminder for the field team',
    },
    success: { status: 201, description: 'Created', data: template, example: ok(example) },
    errors: [409, 422],
    errorExamples: {
      409: {
        message: 'This template already exists; add a new version instead',
        details: { reason: 'TEMPLATE_EXISTS' },
      },
    },
  },
  newVersion: {
    tag: TEMPLATES_TAG,
    summary: 'Edit: create a new version',
    description:
      'Copies key / channel / locale / variables from `{id}` (variables cannot change: events and sends pass exactly those values). Omitted `title` / `htmlBody` / `description` are kept. `activate: false` saves a draft: preview it, then activate. Roll back by activating an older version. `reason` required; audited.',
    operationId: 'createNotificationTemplateVersion',
    auth: AUTH_ADMIN,
    permission: 'notifications.manage',
    rateLimit: '30 writes per user per minute',
    requestExample: {
      title: 'Order {{orderNo}} confirmed 🎉',
      body: 'Good news! Order {{orderNo}} is confirmed.',
      activate: false,
      reason: 'Friendlier wording for the Diwali campaign',
    },
    success: { status: 201, description: 'New version', data: template, example: ok(example) },
    errors: [404, 422],
  },
  activate: {
    tag: TEMPLATES_TAG,
    summary: 'Activate a version (roll forward / back)',
    operationId: 'activateNotificationTemplate',
    auth: AUTH_ADMIN,
    permission: 'notifications.manage',
    rateLimit: '30 writes per user per minute',
    requestExample: { reason: 'Roll back: v3 had a typo in the order link' },
    success: { status: 200, description: 'Now active', data: template, example: ok(example) },
    errors: [404, 422],
  },
  preview: {
    tag: TEMPLATES_TAG,
    summary: 'Preview a version with sample values',
    description:
      'Renders exactly as delivery would (limits, escaping, ₹ / IST formatting). No side effects. Missing or wrong values → 422 per variable.',
    operationId: 'previewNotificationTemplate',
    auth: AUTH_ADMIN,
    permission: 'notifications.view',
    requestExample: { vars: { orderNo: 'ORD-26-0091842' } },
    success: {
      status: 200,
      description: 'Rendered channel',
      data: Joi.object({
        channel: Joi.string().valid(...CHANNELS),
        title: Joi.string().allow(null),
        text: Joi.string(),
        html: Joi.string().allow(null),
      }),
      example: ok({
        channel: 'EMAIL',
        title: 'Order ORD-26-0091842 confirmed',
        text: 'Hello,\n\nYour order ORD-26-0091842 is confirmed …',
        html: '<!doctype html><html>…</html>',
      }),
    },
    errors: [404, 422],
  },
} satisfies Record<string, RouteDocs>;
