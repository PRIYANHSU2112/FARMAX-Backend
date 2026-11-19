import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, IDS, IF_MATCH, VERSION_ETAG, ok, reasonIssue } from '../../docs/shared.js';

export const ADMIN_ATTRIBUTES_TAG = 'Admin · Product Attributes & Compliance';

const PERMISSION = 'catalogue.manage';
const at = '2026-11-14T09:30:00.000Z';

const attribute = Joi.object({
  id: Joi.string().guid(),
  categoryId: Joi.string().guid().description('Category that defines it'),
  key: Joi.string().example('vaccineStrain').description('Key in `Product.attributes`'),
  label: Joi.string().example('Vaccine strain'),
  dataType: Joi.string().valid('TEXT', 'NUMBER', 'BOOLEAN', 'SELECT', 'MULTI_SELECT', 'DATE'),
  unit: Joi.string().allow(null),
  options: Joi.array().items(Joi.string()),
  isRequired: Joi.boolean(),
  isFilterable: Joi.boolean().description('Offered as storefront filter `attr.<key>`'),
  sortOrder: Joi.number().integer(),
  version: Joi.number().integer(),
  inherited: Joi.boolean().description('Defined on an ancestor category'),
}).meta({ className: 'CategoryAttribute' });

const flags = {
  requiresRegistration: Joi.boolean(),
  requiresDrugLicense: Joi.boolean(),
  requiresManufacturingLicense: Joi.boolean(),
  requiresWithdrawal: Joi.boolean(),
  requiresColdChain: Joi.boolean(),
  requiredDocTypes: Joi.array().items(Joi.string()),
  allowedSchedules: Joi.array().items(Joi.string()).description('Empty = any schedule'),
};
const profile = Joi.object({
  id: Joi.string().guid(),
  categoryId: Joi.string().guid(),
  ...flags,
  version: Joi.number().integer(),
}).meta({ className: 'ComplianceProfile' });

const strain = {
  id: IDS.attribute,
  categoryId: IDS.category,
  key: 'vaccineStrain',
  label: 'Vaccine strain',
  dataType: 'SELECT',
  unit: null,
  options: ['Lasota', 'F1', 'R2B', 'Clone 30'],
  isRequired: true,
  isFilterable: true,
  sortOrder: 10,
  version: 0,
  inherited: false,
};
const vaccineProfile = {
  id: IDS.attribute,
  categoryId: IDS.category,
  requiresRegistration: true,
  requiresDrugLicense: true,
  requiresManufacturingLicense: true,
  requiresWithdrawal: false,
  requiresColdChain: true,
  requiredDocTypes: ['LEAFLET', 'PACKAGE_INSERT'],
  allowedSchedules: [],
  version: 0,
  createdByUserId: IDS.admin,
  updatedByUserId: IDS.admin,
  createdAt: at,
  updatedAt: at,
};

export const ATTRIBUTE_DOCS = {
  list: {
    tag: ADMIN_ATTRIBUTES_TAG,
    operationId: 'adminListCategoryAttributes',
    summary: 'Attributes of a category (own + inherited)',
    description:
      '`effective` = every attribute a product in this category must/can fill: own definitions plus those inherited from ancestor categories (a deeper category overriding a key wins).',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    success: {
      status: 200,
      description: 'Own and effective definitions',
      data: Joi.object({
        own: Joi.array().items(attribute),
        effective: Joi.array().items(attribute),
      }),
      example: ok({ own: [strain], effective: [strain] }),
    },
    errors: [404, 422],
  },
  create: {
    tag: ADMIN_ATTRIBUTES_TAG,
    operationId: 'adminCreateCategoryAttribute',
    summary: 'Define an attribute on a category',
    description:
      'Inherited by every sub-category. `options` is required for SELECT / MULTI_SELECT and not allowed otherwise. `key` and `dataType` are immutable afterwards. Audited.',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    requestExample: {
      categoryId: IDS.category,
      key: 'vaccineStrain',
      label: 'Vaccine strain',
      dataType: 'SELECT',
      options: ['Lasota', 'F1', 'R2B', 'Clone 30'],
      isRequired: true,
      isFilterable: true,
      reason: 'Strain is the main buying criterion for ND vaccines',
    },
    success: {
      status: 201,
      description: 'Created',
      data: attribute,
      example: ok(strain),
      headers: VERSION_ETAG,
    },
    errors: [404, 409, 422],
    errorExamples: {
      409: {
        summary: 'ATTRIBUTE_DUPLICATE',
        message: 'Attribute "vaccineStrain" already exists on this category',
        details: { reason: 'ATTRIBUTE_DUPLICATE', fields: ['key'] },
      },
      422: reasonIssue,
    },
  },
  update: {
    tag: ADMIN_ATTRIBUTES_TAG,
    operationId: 'adminUpdateCategoryAttribute',
    summary: 'Edit an attribute definition',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    headers: IF_MATCH,
    requestExample: {
      options: ['Lasota', 'F1', 'R2B', 'Clone 30', 'B1'],
      reason: 'Added B1 strain',
    },
    success: {
      status: 200,
      description: 'Updated',
      data: attribute,
      example: ok({ ...strain, version: 1 }),
      headers: VERSION_ETAG,
    },
    errors: [404, 409, 422],
  },
  remove: {
    tag: ADMIN_ATTRIBUTES_TAG,
    operationId: 'adminDeleteCategoryAttribute',
    summary: 'Remove an attribute definition',
    description: 'Existing product values are kept but no longer shown or validated.',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    headers: IF_MATCH,
    success: { status: 204, description: 'Deleted' },
    errors: [404, 409, 422],
  },
  getProfile: {
    tag: ADMIN_ATTRIBUTES_TAG,
    operationId: 'adminGetComplianceProfile',
    summary: 'Compliance profile of a category (own + effective)',
    description:
      'Regulatory requirements checked when a product in this category is published, on top of the base rule matrix. `effective` merges ancestors (tighten-only: flags OR, documents union, schedules intersect).',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    success: {
      status: 200,
      description: 'Own profile (or null) and the effective rules',
      data: Joi.object({ own: profile.allow(null), effective: Joi.object(flags) }),
      example: ok({ own: vaccineProfile, effective: vaccineProfile }),
    },
    errors: [404, 422],
  },
  putProfile: {
    tag: ADMIN_ATTRIBUTES_TAG,
    operationId: 'adminPutComplianceProfile',
    summary: 'Create or update a category compliance profile',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    headers: IF_MATCH,
    requestExample: {
      requiresRegistration: true,
      requiresDrugLicense: true,
      requiresColdChain: true,
      requiredDocTypes: ['LEAFLET', 'PACKAGE_INSERT'],
      reason: 'Vaccines need CDSCO registration, licence and cold chain',
    },
    success: {
      status: 200,
      description: 'Saved',
      data: profile,
      example: ok(vaccineProfile),
      headers: VERSION_ETAG,
    },
    errors: [404, 409, 422],
  },
  removeProfile: {
    tag: ADMIN_ATTRIBUTES_TAG,
    operationId: 'adminDeleteComplianceProfile',
    summary: 'Remove a category compliance profile',
    auth: AUTH_ADMIN,
    permission: PERMISSION,
    success: { status: 204, description: 'Deleted' },
    errors: [404, 422],
  },
} satisfies Record<string, RouteDocs>;
