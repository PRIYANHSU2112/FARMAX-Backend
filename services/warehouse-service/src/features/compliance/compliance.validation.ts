import Joi from 'joi';

import { ID, VERSION } from '../../middleware/http.js';
import { PAGING } from '../../middleware/paging.js';

const NOTE = Joi.string().trim().max(500).allow(null, '');
const RECEIPT = Joi.string().trim().min(20).max(4000);
const CHECK_TYPES = ['VET_RX', 'DRUG_LICENCE', 'RESTRICTED_PERMIT', 'FARMER_DECLARATION', 'COA'];

export const whQuery = { querystring: Joi.object({ warehouseId: ID }) };
export const casesQuery = {
  querystring: Joi.object({
    status: Joi.string().valid(
      'PENDING',
      'FLAGGED',
      'ON_HOLD',
      'APPROVED',
      'REJECTED',
      'NOT_REQUIRED',
    ),
    q: Joi.string().trim().min(1).max(40),
    warehouseId: ID,
    ...PAGING,
  }),
};
export const caseParams = { params: Joi.object({ id: ID.required() }) };
export const checkParams = { params: Joi.object({ id: ID.required(), checkId: ID.required() }) };

export const documentSchema = {
  ...caseParams,
  body: Joi.object({
    checkId: ID.required(),
    receipt: RECEIPT.required(),
    documentNo: Joi.string().trim().max(60).allow(null),
    issuerName: Joi.string().trim().max(120).allow(null),
    issuerRegNo: Joi.string().trim().max(60).allow(null),
    validUntil: Joi.string()
      .pattern(/^\d{4}-\d{2}-\d{2}$/)
      .allow(null),
    note: NOTE,
  }),
};
export const evidenceSchema = {
  ...caseParams,
  body: Joi.object({
    docType: Joi.string().valid('RX_SCAN', 'LICENCE', 'DECLARATION', 'OTHER').required(),
    receipt: RECEIPT.required(),
    checkId: ID.allow(null),
    note: NOTE,
  }),
};
export const checkDecisionSchema = {
  ...checkParams,
  body: Joi.object({ decision: Joi.string().valid('VERIFIED', 'REJECTED').required(), note: NOTE }),
};
export const inspectorSchema = {
  ...caseParams,
  body: Joi.object({ inspectorUserId: ID.allow(null).required() }),
};
export const noteSchema = {
  ...caseParams,
  body: Joi.object({ body: Joi.string().trim().min(2).max(1000).required() }),
};
export const requestSchema = {
  ...checkParams,
  body: Joi.object({ channel: Joi.string().valid('SMS', 'IN_APP', 'WHATSAPP').default('SMS') })
    .empty(null)
    .default({}),
};
export const decisionSchema = {
  ...caseParams,
  body: Joi.object({
    decision: Joi.string().valid('APPROVE', 'HOLD', 'REJECT').required(),
    note: NOTE,
    expectedVersion: VERSION.required(),
  }),
};
export const waiverSchema = {
  ...caseParams,
  body: Joi.object({
    authorizationNo: Joi.string().trim().min(3).max(60).required(),
    receipt: RECEIPT.allow(null),
    totpCode: Joi.string()
      .pattern(/^\d{6}$/)
      .required(),
    checkIds: Joi.array().items(ID).min(1).max(20),
    note: NOTE,
  }),
};
export const ruleSchema = {
  params: Joi.object({
    key: Joi.string()
      .trim()
      .pattern(/^[A-Z][A-Z0-9_]{1,39}$/)
      .required(),
  }),
  body: Joi.object({
    name: Joi.string().trim().min(3).max(120).required(),
    appliesWhen: Joi.object({
      drugSchedules: Joi.array().items(Joi.string().trim().max(4)).max(10),
      antimicrobial: Joi.boolean(),
      vetConsult: Joi.boolean(),
      hazardous: Joi.boolean(),
      hazardClasses: Joi.array().items(Joi.string().trim().max(40)).max(20),
    })
      .min(1)
      .required(),
    requiredChecks: Joi.array()
      .items(Joi.string().valid(...CHECK_TYPES))
      .min(1)
      .unique()
      .required(),
    legalBasis: Joi.string().trim().max(200).allow(null),
    periodLimitQty: Joi.number().integer().min(1).allow(null),
    isActive: Joi.boolean(),
  }),
};
export const inspectorPutSchema = {
  params: Joi.object({ userId: ID.required() }),
  body: Joi.object({
    displayName: Joi.string().trim().min(2).max(120).required(),
    title: Joi.string().trim().max(120).allow(null),
    govtRegNo: Joi.string().trim().max(60).allow(null),
    photoReceipt: RECEIPT.allow(null),
    onDuty: Joi.boolean(),
  }),
};
export const auditQuery = {
  querystring: Joi.object({
    status: Joi.string().valid('PENDING', 'FLAGGED', 'ON_HOLD', 'APPROVED', 'REJECTED'),
    warehouseId: ID,
  }),
};
