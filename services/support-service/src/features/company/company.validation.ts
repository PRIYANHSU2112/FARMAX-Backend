import Joi from 'joi';

import { PAGE, REASON } from '../../middleware/http.js';
import { RECEIPTS } from '../tickets/index.js';
import { APPLICATION_STATUSES, APPLICATION_TYPES, COMPANY_DOC_TYPES } from './company.types.js';

const DOC_TYPE = Joi.string().valid(...COMPANY_DOC_TYPES);
const APP_TYPE = Joi.string().valid(...APPLICATION_TYPES);

const docFields = {
  type: DOC_TYPE,
  title: Joi.string().trim().min(2).max(160),
  documentNo: Joi.string().trim().min(2).max(80),
  issuingAuthority: Joi.string().trim().min(2).max(160),
  expiresAt: Joi.date().iso().allow(null),
  fileUrl: Joi.string()
    .uri({ scheme: ['https', 'http'] })
    .max(1000),
  isPublic: Joi.boolean(),
};

export const docListQuery = Joi.object({ type: DOC_TYPE, isPublic: Joi.boolean() });

export const createDocBody = Joi.object({
  ...docFields,
  type: DOC_TYPE.required(),
  title: docFields.title.required(),
  documentNo: docFields.documentNo.required(),
  issuingAuthority: docFields.issuingAuthority.required(),
  fileUrl: docFields.fileUrl.required(),
});

export const updateDocBody = Joi.object(docFields).min(1);

export const deleteDocBody = Joi.object({ reason: REASON.required() });

export const applyBody = Joi.object({
  businessName: Joi.string().trim().min(2).max(160).required(),
  applicationType: APP_TYPE.required(),
  attachments: RECEIPTS.min(1).required(),
});

export const queueQuery = Joi.object({
  status: Joi.string().valid(...APPLICATION_STATUSES),
  type: APP_TYPE,
  ...PAGE,
});

export const reviewBody = Joi.object({
  status: Joi.string().valid('APPROVED', 'REJECTED').required(),
  reviewNotes: Joi.when('status', {
    is: 'REJECTED',
    then: REASON.required(),
    otherwise: Joi.string().trim().max(500).allow(null, ''),
  }),
});
