import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@farmx/database';
import Joi from 'joi';

const ID = Joi.string().guid();

export const verificationSchema = { params: Joi.object({ id: ID.required() }) };

export const claimSchema = {
  params: Joi.object({ id: ID.required() }),
  body: Joi.object({ claim: Joi.string().valid('SEPARATE_UNIT', 'SAME_FARM').required() }),
};

export const queueSchema = {
  querystring: Joi.object({
    assignee: Joi.string().valid('me', 'unassigned'),
    overdue: Joi.boolean(),
    cursor: ID,
    limit: Joi.number().integer().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  }),
};

export const caseParams = { params: Joi.object({ caseId: ID.required() }) };

export const assignSchema = { ...caseParams, body: Joi.object({ assigneeUserId: ID.required() }) };

export const decisionSchema = {
  ...caseParams,
  body: Joi.object({
    decision: Joi.string()
      .valid('APPROVE_SEPARATE', 'MERGE', 'REQUEST_CHANGES', 'REJECT')
      .required(),
    reason: Joi.string().trim().min(10).max(500).required(),
    issues: Joi.array()
      .items(
        Joi.object({
          docType: Joi.string()
            .valid(
              'PAN_CARD',
              'GST_CERTIFICATE',
              'ID_PROOF_FRONT',
              'ID_PROOF_BACK',
              'OTHER',
              'DETAILS',
              'LOCATION',
            )
            .required(),
          code: Joi.string()
            .valid('BLURRY', 'MISMATCH', 'EXPIRED', 'INCOMPLETE', 'OTHER')
            .required(),
          message: Joi.string().trim().min(5).max(300).required(),
        }),
      )
      .min(1)
      .max(10)
      .when('decision', {
        is: 'REQUEST_CHANGES',
        then: Joi.required(),
        otherwise: Joi.forbidden(),
      }),
  }),
};
