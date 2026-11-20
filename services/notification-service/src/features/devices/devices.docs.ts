import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_USER, IDS, ok } from '../../docs/shared.js';
import { APPS } from '../../domain.js';
import { PLATFORMS } from './devices.types.js';

export const DEVICES_TAG = 'Notification Devices';

const device = Joi.object({
  id: Joi.string().guid(),
  app: Joi.string().valid(...APPS),
  platform: Joi.string().valid(...PLATFORMS),
  deviceId: Joi.string().allow(null),
  lastSeenAt: Joi.date().iso(),
  createdAt: Joi.date().iso(),
}).meta({ className: 'Device' });

const example = {
  id: IDS.device,
  app: 'CUSTOMER',
  platform: 'ANDROID',
  deviceId: 'install-7f3a9c',
  lastSeenAt: '2026-11-24T10:15:00.000Z',
  createdAt: '2026-11-20T08:00:00.000Z',
};

export const DEVICES_DOCS = {
  register: {
    tag: DEVICES_TAG,
    summary: 'Register / refresh this device for push',
    description:
      "Call after sign-in and whenever Firebase rotates the token. Upsert by token: a token registered by another account moves to the caller (shared / resold phones never get the previous owner's pushes). At most 10 active devices per user; the least recently seen is dropped. The token is never returned.",
    operationId: 'registerMyDevice',
    auth: AUTH_USER,
    rateLimit: '10 per user per minute',
    requestExample: {
      token: 'dX3k…FCM-registration-token…9pQ',
      platform: 'ANDROID',
      app: 'CUSTOMER',
      deviceId: 'install-7f3a9c',
    },
    success: { status: 200, description: 'Registered device', data: device, example: ok(example) },
    errors: [422],
  },
  list: {
    tag: DEVICES_TAG,
    summary: 'My registered devices',
    operationId: 'listMyDevices',
    auth: AUTH_USER,
    success: { status: 200, description: 'Active devices', data: device, example: ok([example]) },
  },
  remove: {
    tag: DEVICES_TAG,
    summary: 'Unregister a device (sign-out)',
    description: 'Idempotent. Call on sign-out so the device stops receiving pushes.',
    operationId: 'removeMyDevice',
    auth: AUTH_USER,
    rateLimit: '10 per user per minute',
    success: { status: 204, description: 'Removed' },
    errors: [404, 422],
    errorExamples: { 404: { message: 'Device not found' } },
  },
} satisfies Record<string, RouteDocs>;
