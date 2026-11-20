import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_USER, ok } from '../../docs/shared.js';
import { CATEGORIES } from '../../domain.js';

export const PREFERENCES_TAG = 'Notification Preferences';

const view = Joi.object({
  category: Joi.string().valid(...CATEGORIES),
  mandatory: Joi.boolean().description('Always delivered (SECURITY); toggles are read-only'),
  push: Joi.boolean(),
  email: Joi.boolean(),
  sms: Joi.boolean().description('SMS is only ever used for HIGH / CRITICAL notifications'),
}).meta({ className: 'NotificationPreference' });

const example = ok([
  { category: 'ORDER', mandatory: false, push: true, email: false, sms: true },
  { category: 'PROMO', mandatory: false, push: false, email: false, sms: false },
  { category: 'SECURITY', mandatory: true, push: true, email: true, sms: true },
]);

const POLICY =
  'In-app notifications are always on. Defaults: every category on, except PROMO (opt-in). SECURITY notifications and CRITICAL priority ignore opt-outs.';

export const PREFERENCES_DOCS = {
  get: {
    tag: PREFERENCES_TAG,
    summary: 'My notification preferences',
    description: POLICY,
    operationId: 'getMyNotificationPreferences',
    auth: AUTH_USER,
    success: { status: 200, description: 'One row per category', data: view, example },
  },
  update: {
    tag: PREFERENCES_TAG,
    summary: 'Change my notification preferences',
    description: `Send only the toggles that changed. ${POLICY}`,
    operationId: 'updateMyNotificationPreferences',
    auth: AUTH_USER,
    rateLimit: '20 per user per minute',
    requestExample: {
      changes: [
        { category: 'ORDER', channel: 'EMAIL', enabled: false },
        { category: 'PROMO', channel: 'PUSH', enabled: true },
      ],
    },
    success: { status: 200, description: 'The full matrix after the change', data: view, example },
    errors: [422],
  },
} satisfies Record<string, RouteDocs>;
