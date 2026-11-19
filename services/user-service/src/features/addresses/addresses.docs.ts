import type { DocHeader, RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import {
  ADMIN_CUSTOMERS_TAG,
  AUTH_ADMIN,
  AUTH_CUSTOMER,
  IDEMPOTENCY_KEY,
  IDS,
  PERMISSION_VIEW,
  READ_RATE,
  WRITE_RATE,
  ok,
} from '../../docs/shared.js';
import { ADDRESS_TYPES } from './addresses.types.js';

export const ADDRESSES_TAG = 'Me · Addresses';

const IF_MATCH: Record<string, DocHeader> = {
  'If-Match': {
    description:
      'Address `version` from the last read (`3`, `"3"` or `W/"3"`). If it differs → 409 `ADDRESS_VERSION_CONFLICT`. Optional, recommended.',
    schema: { type: 'string', example: '"3"' },
  },
};
const VERSION_ETAG: Record<string, DocHeader> = {
  ETag: {
    description: 'Current address `version`, quoted. Send it back as `If-Match`.',
    schema: { type: 'string', example: '"1"' },
  },
};

// ── Schemas ──

const fields = {
  type: Joi.string().valid(...ADDRESS_TYPES),
  label: Joi.string().allow(null).example('Main farm'),
  contactName: Joi.string().example('Ravi Kumar'),
  contactPhone: Joi.string().example('+919876543210').description('E.164'),
  line1: Joi.string().example('Plot 12, Survey No. 45'),
  line2: Joi.string().allow(null),
  landmark: Joi.string().allow(null).example('Near Hanuman temple'),
  village: Joi.string().allow(null).example('Kondapur'),
  mandal: Joi.string().allow(null).example('Serilingampally'),
  district: Joi.string().example('Rangareddy'),
  stateCode: Joi.string().length(2).example('TG'),
  pinCode: Joi.string().length(6).example('500084'),
  latitude: Joi.number().allow(null).example(17.4618),
  longitude: Joi.number().allow(null).example(78.3568),
};

const address = Joi.object({
  id: Joi.string().guid(),
  ...fields,
  isDefault: Joi.boolean().description('Exactly one live default per customer'),
  version: Joi.number().integer().description('Send as `If-Match` on writes'),
  createdAt: Joi.date(),
  updatedAt: Joi.date(),
}).meta({ className: 'Address' });

const adminAddress = address
  .keys({ userId: Joi.string().guid(), deletedAt: Joi.date().allow(null) })
  .meta({ className: 'AdminAddress' });

const auditRecord = Joi.object({
  id: Joi.string().guid(),
  actorUserId: Joi.string().guid(),
  action: Joi.string().example('address.update'),
  reason: Joi.string().allow(null),
  createdAt: Joi.date(),
}).meta({ className: 'AddressAuditRecord' });

// ── Examples ──

const at = '2026-11-16T09:30:00.000Z';
const home = {
  id: IDS.address,
  type: 'FARM',
  label: 'Main farm',
  contactName: 'Ravi Kumar',
  contactPhone: '+919876543210',
  line1: 'Plot 12, Survey No. 45',
  line2: null,
  landmark: 'Near Hanuman temple',
  village: 'Kondapur',
  mandal: 'Serilingampally',
  district: 'Rangareddy',
  stateCode: 'TG',
  pinCode: '500084',
  latitude: 17.4618,
  longitude: 78.3568,
  isDefault: true,
  version: 0,
  createdAt: at,
  updatedAt: at,
};
const notFound = { message: 'Address not found' };
const versionConflict = {
  summary: 'ADDRESS_VERSION_CONFLICT (stale If-Match)',
  message: 'The address was changed elsewhere; reload and retry',
  details: { reason: 'ADDRESS_VERSION_CONFLICT', currentVersion: 2 },
};
const limit = {
  summary: 'ADDRESS_LIMIT (20 saved addresses)',
  message: 'You can save at most 20 addresses',
  details: { reason: 'ADDRESS_LIMIT', max: 20 },
};
const badPin = {
  summary: 'Invalid PIN / phone',
  message: 'Validation failed',
  details: { issues: [{ path: 'body.pinCode', message: '"pinCode" must be a 6-digit PIN code' }] },
};

const me = (extra: Omit<RouteDocs, 'tag' | 'auth'>): RouteDocs => ({
  tag: ADDRESSES_TAG,
  auth: AUTH_CUSTOMER,
  ...extra,
});

export const ADDRESS_DOCS = {
  list: me({
    operationId: 'listMyAddresses',
    summary: 'My saved addresses',
    description: 'Default first, then most recently changed. At most 20, so no pagination.',
    rateLimit: READ_RATE,
    success: {
      status: 200,
      description: 'Addresses',
      data: Joi.array().items(address),
      example: ok([home]),
    },
    errors: [],
  }),
  get: me({
    operationId: 'getMyAddress',
    summary: 'One saved address',
    rateLimit: READ_RATE,
    success: {
      status: 200,
      description: 'Address',
      data: address,
      example: ok(home),
      headers: VERSION_ETAG,
    },
    errors: [404, 422],
    errorExamples: { 404: notFound },
  }),
  create: me({
    operationId: 'createMyAddress',
    summary: 'Save a new address',
    description:
      'The first address becomes the default automatically; `isDefault: true` moves the default to this one. A 10-digit mobile is stored as `+91…`. `latitude` and `longitude` go together. Max 20 addresses.',
    rateLimit: WRITE_RATE,
    headers: IDEMPOTENCY_KEY,
    requestExample: {
      type: 'FARM',
      label: 'Main farm',
      contactName: 'Ravi Kumar',
      contactPhone: '9876543210',
      line1: 'Plot 12, Survey No. 45',
      landmark: 'Near Hanuman temple',
      village: 'Kondapur',
      mandal: 'Serilingampally',
      district: 'Rangareddy',
      stateCode: 'tg',
      pinCode: '500084',
      latitude: 17.4618,
      longitude: 78.3568,
      isDefault: true,
    },
    success: {
      status: 201,
      description: 'Created',
      data: address,
      example: ok(home),
      headers: VERSION_ETAG,
    },
    errors: [409, 422],
    errorExamples: { 409: limit, 422: badPin },
  }),
  update: me({
    operationId: 'updateMyAddress',
    summary: 'Edit an address',
    description:
      'Any subset of fields; `null` or `""` clears an optional one. To change the default use `POST /{id}/default`. Past orders keep their own copy, so edits never change them.',
    rateLimit: WRITE_RATE,
    headers: IF_MATCH,
    requestExample: { landmark: 'Opposite the milk centre', contactPhone: '+919812345678' },
    success: {
      status: 200,
      description: 'Updated',
      data: address,
      example: ok({ ...home, landmark: 'Opposite the milk centre', version: 1 }),
      headers: VERSION_ETAG,
    },
    errors: [404, 409, 422],
    errorExamples: { 404: notFound, 409: versionConflict, 422: badPin },
  }),
  setDefault: me({
    operationId: 'setMyDefaultAddress',
    summary: 'Make an address the default',
    description: 'The previous default is cleared in the same transaction.',
    rateLimit: WRITE_RATE,
    success: {
      status: 200,
      description: 'The new default',
      data: address,
      example: ok({ ...home, version: 1 }),
      headers: VERSION_ETAG,
    },
    errors: [404, 422],
    errorExamples: { 404: notFound },
  }),
  remove: me({
    operationId: 'deleteMyAddress',
    summary: 'Delete an address',
    description:
      'Soft delete (orders that used it keep their snapshot). Deleting the default makes the most recently changed remaining address the default.',
    rateLimit: WRITE_RATE,
    headers: IF_MATCH,
    success: { status: 204, description: 'Deleted' },
    errors: [404, 409, 422],
    errorExamples: { 404: notFound, 409: versionConflict },
  }),

  adminList: {
    tag: ADMIN_CUSTOMERS_TAG,
    operationId: 'adminListCustomerAddresses',
    summary: 'A customer’s addresses (support)',
    description: '`includeDeleted=true` also returns soft-deleted addresses.',
    auth: AUTH_ADMIN,
    permission: PERMISSION_VIEW,
    success: {
      status: 200,
      description: 'Addresses',
      data: Joi.array().items(adminAddress),
      example: ok([{ ...home, userId: IDS.customer, deletedAt: null }]),
    },
    errors: [422],
  },
  adminHistory: {
    tag: ADMIN_CUSTOMERS_TAG,
    operationId: 'adminCustomerAddressHistory',
    summary: 'Change history of a customer address',
    description: 'Newest first; kept after the address is deleted.',
    auth: AUTH_ADMIN,
    permission: PERMISSION_VIEW,
    success: {
      status: 200,
      description: 'A page of audit rows',
      data: auditRecord,
      paginated: true,
      example: ok(
        [
          {
            id: IDS.audit,
            actorUserId: IDS.customer,
            action: 'address.update',
            reason: null,
            createdAt: at,
          },
        ],
        { nextCursor: null, limit: 20 },
      ),
    },
    errors: [404, 422],
    errorExamples: { 404: notFound },
  },
} satisfies Record<string, RouteDocs>;
