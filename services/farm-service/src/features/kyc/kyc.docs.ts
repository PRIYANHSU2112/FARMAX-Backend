import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

export const KYC_TAG = 'Farms · KYC';
export const ADMIN_KYC_TAG = 'Admin · Farm KYC';

const docSchema = Joi.object({
  id: Joi.string().guid(),
  farmId: Joi.string().guid().allow(null),
  docType: Joi.string().valid(
    'PAN_CARD',
    'GST_CERTIFICATE',
    'ID_PROOF_FRONT',
    'ID_PROOF_BACK',
    'OTHER',
  ),
  contentType: Joi.string().example('image/webp'),
  sizeBytes: Joi.number().example(412000),
  status: Joi.string().valid('UPLOADED', 'ACCEPTED', 'REJECTED', 'SUPERSEDED'),
  rejectionCode: Joi.string().allow(null),
  rejectionNote: Joi.string().allow(null),
  reviewedAt: Joi.date().iso().allow(null),
  createdAt: Joi.date().iso(),
}).meta({ className: 'KycDocument' });

const gstSchema = Joi.object({
  verificationId: Joi.string().guid(),
  gstin: Joi.string().example('37AKLPK7741Q1ZV'),
  tradeName: Joi.string().allow(null).example('Sri Lakshmi Agro Farms'),
  legalName: Joi.string().example('K. Venkata Ramana'),
  businessName: Joi.string()
    .example('K. Venkata Ramana')
    .description('GST "Legal Name of Business" (same as legalName); stored on the farm'),
  stateCode: Joi.string().example('37').description('GST state code (GSTIN prefix)'),
  stateMatchesFarm: Joi.boolean()
    .allow(null)
    .description(
      'false → billing will be refused (GSTIN registered in another state); null → farm has no location yet',
    ),
  portalStatus: Joi.string().valid('ACTIVE', 'CANCELLED', 'SUSPENDED', 'INACTIVE'),
  checkedAt: Joi.date().iso(),
  nameMatchesFarm: Joi.boolean().description(
    'false → show "Trade name on GST portal doesn’t match farm name"',
  ),
  panMatchesGstin: Joi.boolean().allow(null),
  options: Joi.array().items(Joi.string().valid('GST_TRADE_NAME', 'FARM_NAME')),
}).meta({ className: 'GstVerification' });

const EXT = 'Calls an external provider: 3 s timeout + circuit breaker (503 when unavailable).';

export const KYC_DOCS = {
  aadhaarOtp: {
    tag: KYC_TAG,
    summary: 'Send Aadhaar OTP (owner consent)',
    description: `Validates the Verhoeff check digit. The number is never stored or logged — only the last 4 digits. 3/h per user. ${EXT}`,
    success: {
      status: 200,
      description: 'OTP sent',
      data: Joi.object({
        txnRef: Joi.string(),
        expiresIn: Joi.number().example(600),
        maskedAadhaar: Joi.string().example('XXXX XXXX 4417'),
      }),
    },
    errors: [404, 409, 422, 503],
  },
  aadhaarVerify: {
    tag: KYC_TAG,
    summary: 'Verify Aadhaar OTP',
    description: `Max 5 attempts per OTP. ${EXT}`,
    success: {
      status: 200,
      description: 'Verified',
      data: Joi.object({
        verified: Joi.boolean(),
        aadhaarLast4: Joi.string(),
        nameMatch: Joi.boolean(),
      }),
    },
    errors: [404, 409, 422, 503],
  },
  pan: {
    tag: KYC_TAG,
    summary: 'Save owner PAN',
    description: 'Encrypted at rest (AES-256-GCM), masked in every response.',
    success: {
      status: 200,
      description: 'Saved',
      data: Joi.object({ panMasked: Joi.string().example('AKLPK****Q'), kycStatus: Joi.string() }),
    },
    errors: [404, 409, 422],
  },
  document: {
    tag: KYC_TAG,
    summary: 'Attach an uploaded KYC document',
    description:
      'Upload the file to media-service first (private), then send its key + SHA-256. Replaces the previous document of the same type.',
    success: { status: 201, description: 'Attached', data: docSchema },
    errors: [404, 409, 422],
  },
  gstin: {
    tag: KYC_TAG,
    summary: 'Check a GSTIN on the GST portal',
    description: `Checksum first, then a 24 h cached portal lookup. ${EXT}`,
    success: { status: 200, description: 'Portal snapshot', data: gstSchema },
    errors: [404, 409, 422, 503],
  },
  billing: {
    tag: KYC_TAG,
    summary: 'Bind the verified GSTIN for B2B / ITC billing ("Invoice as …")',
    description:
      'Registration step 4. Takes the `verificationId` from `POST /{id}/kyc/gstin/verify`; business and trade names are copied from the GST portal snapshot (never sent by the client). 422 when the check is older than 24 h or the GSTIN state differs from the farm state. Emits `farm.facts_changed.v1` with `gstVerified`, `gstBusinessName`, `gstTradeName`, `invoiceName`.',
    success: {
      status: 200,
      description: 'Updated farm',
      data: Joi.object().meta({ className: 'Farm' }),
    },
    errors: [404, 409, 422],
  },
  adminDocs: {
    tag: ADMIN_KYC_TAG,
    summary: 'List a farm owner’s KYC documents',
    permission: 'customers.verify',
    success: {
      status: 200,
      description: 'Current documents (no file URLs)',
      data: Joi.array().items(docSchema),
    },
    errors: [404, 422],
  },
  adminDecide: {
    tag: ADMIN_KYC_TAG,
    summary: 'Accept or reject a document',
    permission: 'customers.verify',
    description:
      'REJECT needs `rejectionCode` + `note` (shown to the owner). Reviewer ≠ creator/owner. Audited.',
    success: { status: 200, description: 'Decided', data: docSchema },
    errors: [404, 409, 422],
  },
} satisfies Record<string, RouteDocs>;
