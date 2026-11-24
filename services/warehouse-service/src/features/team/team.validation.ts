import Joi from 'joi';

import { ID, REASON } from '../../middleware/http.js';
import { WORK_AREAS } from './team.types.js';

const wh = { id: ID.required() };
const member = { ...wh, userId: ID.required() };
const PHONE = Joi.string()
  .trim()
  .pattern(/^(\+91)?[6-9]\d{9}$/)
  .messages({ 'string.pattern.base': 'must be a 10-digit mobile number' });
const AREAS = Joi.array()
  .items(Joi.string().valid(...WORK_AREAS))
  .unique()
  .description('Empty = all areas');

export const teamSchema = { params: Joi.object(wh) };
export const memberParams = { params: Joi.object(member) };

export const addSchema = {
  params: Joi.object(wh),
  body: Joi.object({
    fullName: Joi.string().trim().min(2).max(120).required(),
    email: Joi.string().trim().lowercase().email().max(254).required(),
    phone: PHONE.allow(null),
    roleId: ID.required().description(
      'A warehouse role template (GET /admin/warehouses/team/roles)',
    ),
    workAreas: AREAS,
    shiftId: ID.allow(null),
    jobTitle: Joi.string().trim().max(80).allow(null, ''),
  }),
};

export const updateSchema = {
  params: Joi.object(member),
  body: Joi.object({
    phone: PHONE.allow(null),
    workAreas: AREAS,
    shiftId: ID.allow(null),
    jobTitle: Joi.string().trim().max(80).allow(null, ''),
    roleId: ID,
    reason: REASON,
  }).or('phone', 'workAreas', 'shiftId', 'roleId', 'jobTitle'),
};

export const removeSchema = {
  params: Joi.object(member),
  body: Joi.object({ reason: REASON.required() }),
};

export const documentSchema = {
  params: Joi.object(member),
  body: Joi.object({
    docType: Joi.string().valid('ID_PROOF', 'ADDRESS_PROOF', 'PHOTO').required(),
    receipt: Joi.string()
      .max(2048)
      .required()
      .description('`receipt` from media-service POST /v1/upload?purpose=staff_document'),
  }),
};
