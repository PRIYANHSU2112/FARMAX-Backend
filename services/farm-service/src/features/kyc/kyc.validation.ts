import Joi from 'joi';

import { PAN_PATTERN, isValidAadhaar } from './kyc.checks.js';

const ID = Joi.string().guid();
const DOC_TYPES = [
  'PAN_CARD',
  'GST_CERTIFICATE',
  'ID_PROOF_FRONT',
  'ID_PROOF_BACK',
  'OTHER',
] as const;
const farmParams = Joi.object({ id: ID.required() });

export const aadhaarOtpSchema = {
  params: farmParams,
  body: Joi.object({
    aadhaarNumber: Joi.string()
      .replace(/\s/g, '')
      .custom((value: string, helpers) =>
        isValidAadhaar(value) ? value : helpers.error('any.invalid'),
      )
      .required()
      .messages({ 'any.invalid': 'is not a valid Aadhaar number' }),
    consent: Joi.boolean()
      .valid(true)
      .required()
      .messages({ 'any.only': 'owner consent is required' }),
  }),
};

export const aadhaarVerifySchema = {
  params: farmParams,
  body: Joi.object({
    txnRef: Joi.string().trim().min(8).max(100).required(),
    otp: Joi.string()
      .pattern(/^[0-9]{6}$/)
      .required(),
  }),
};

export const panSchema = {
  params: farmParams,
  body: Joi.object({
    pan: Joi.string()
      .uppercase()
      .trim()
      .pattern(PAN_PATTERN)
      .required()
      .messages({ 'string.pattern.base': 'is not a valid PAN' }),
  }),
};

export const documentSchema = {
  params: farmParams,
  body: Joi.object({
    docType: Joi.string()
      .valid(...DOC_TYPES)
      .required(),
    /** Object key returned by media-service (private upload). Never a URL. */
    storageKey: Joi.string()
      .pattern(/^[A-Za-z0-9/_.-]{5,300}$/)
      .required(),
    sha256: Joi.string().hex().length(64).lowercase().required(),
    contentType: Joi.string()
      .valid('image/webp', 'image/jpeg', 'image/png', 'application/pdf')
      .required(),
    sizeBytes: Joi.number()
      .integer()
      .min(1)
      .max(10 * 1024 * 1024)
      .required(),
  }),
};

export const gstinSchema = {
  params: farmParams,
  body: Joi.object({ gstin: Joi.string().uppercase().trim().length(15).required() }),
};

export const billingSchema = {
  params: farmParams,
  body: Joi.object({
    verificationId: ID.required(),
    invoiceNameSource: Joi.string().valid('FARM_NAME', 'GST_TRADE_NAME').required(),
  }),
};

export const adminDocsSchema = { params: farmParams };

export const documentDecisionSchema = {
  params: Joi.object({ id: ID.required(), docId: ID.required() }),
  body: Joi.object({
    decision: Joi.string().valid('ACCEPT', 'REJECT').required(),
    rejectionCode: Joi.string()
      .valid('BLURRY', 'MISMATCH', 'EXPIRED', 'INCOMPLETE', 'OTHER')
      .when('decision', { is: 'REJECT', then: Joi.required(), otherwise: Joi.forbidden() }),
    note: Joi.string()
      .trim()
      .min(5)
      .max(300)
      .when('decision', { is: 'REJECT', then: Joi.required(), otherwise: Joi.forbidden() }),
    reason: Joi.string().trim().min(10).max(500).required(),
  }),
};
