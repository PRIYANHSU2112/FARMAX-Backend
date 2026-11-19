import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

export const VERIFICATION_TAG = 'Farms · Verification';
export const ADMIN_REVIEW_TAG = 'Admin · Farm Review';

const uuid = Joi.string().guid();
const issue = Joi.object({
  docType: Joi.string().example('ID_PROOF_BACK'),
  code: Joi.string().example('BLURRY'),
  message: Joi.string().example(
    'The text on the back of your ID is illegible. Please use better lighting.',
  ),
});

const caseSchema = Joi.object({
  id: uuid,
  farmId: uuid,
  matchedFarmId: uuid,
  matchedOwnerId: uuid,
  sameOwner: Joi.boolean(),
  signals: Joi.array().items(
    Joi.string().valid('PAN_OTHER_OWNER', 'GSTIN_OTHER_OWNER', 'GEO_SAME_OWNER', 'GEO_NAME'),
  ),
  score: Joi.number().example(40),
  distanceM: Joi.number().allow(null).example(140),
  nameSimilarity: Joi.number().allow(null).example(0.82),
  ownerClaim: Joi.string().valid('SEPARATE_UNIT', 'SAME_FARM').allow(null),
  ownerClaimAt: Joi.date().iso().allow(null),
  status: Joi.string().valid(
    'OPEN',
    'RESOLVED_SEPARATE',
    'RESOLVED_MERGED',
    'RESOLVED_CHANGES',
    'RESOLVED_REJECTED',
  ),
  assignedToUserId: uuid.allow(null),
  slaDueAt: Joi.date().iso(),
  resolvedByUserId: uuid.allow(null),
  resolvedAt: Joi.date().iso().allow(null),
  resolutionNote: Joi.string().allow(null),
  createdAt: Joi.date().iso(),
}).meta({ className: 'DuplicateCase' });

const verificationSchema = Joi.object({
  farmId: uuid,
  status: Joi.string().example('UNDER_REVIEW'),
  statusLabel: Joi.string().valid('Under Review', 'Needs Attention', 'Verified', 'Draft', 'Closed'),
  timeline: Joi.array().items(
    Joi.object({
      step: Joi.number(),
      label: Joi.string(),
      done: Joi.boolean(),
      at: Joi.date().iso().allow(null),
    }),
  ),
  question: Joi.object({
    caseId: uuid,
    message: Joi.string(),
    matchedFarm: Joi.object({
      name: Joi.string(),
      farmCode: Joi.string().allow(null),
      distanceM: Joi.number().allow(null),
    })
      .allow(null)
      .description('Only for the same owner’s own farm'),
    ownerClaim: Joi.string().allow(null),
  }).allow(null),
  issues: Joi.array().items(issue),
}).meta({ className: 'FarmVerification' });

export const REVIEW_DOCS = {
  verification: {
    tag: VERIFICATION_TAG,
    summary: 'Verification status (Under review / Needs attention)',
    description:
      'Timeline, the "separate unit?" question and per-document issues. Another owner’s data is never shown.',
    success: { status: 200, description: 'Verification', data: verificationSchema },
    errors: [404, 422],
  },
  claim: {
    tag: VERIFICATION_TAG,
    summary: 'Answer "Is this a separate unit?"',
    description:
      '`SAME_FARM` on your own nearby farm merges this registration into it immediately; `SEPARATE_UNIT` goes to a reviewer.',
    success: { status: 200, description: 'Updated verification', data: verificationSchema },
    errors: [404, 409, 422],
  },
  queue: {
    tag: ADMIN_REVIEW_TAG,
    summary: 'Duplicate review queue (by SLA)',
    permission: 'customers.verify',
    success: {
      status: 200,
      description: 'Open cases, oldest SLA first',
      data: caseSchema,
      paginated: true,
    },
    errors: [422],
  },
  getCase: {
    tag: ADMIN_REVIEW_TAG,
    summary: 'Case with both farms side by side',
    permission: 'customers.verify',
    success: {
      status: 200,
      description: 'Case',
      data: caseSchema.keys({
        farm: Joi.object().allow(null),
        matchedFarm: Joi.object().allow(null),
      }),
    },
    errors: [404, 422],
  },
  assign: {
    tag: ADMIN_REVIEW_TAG,
    summary: 'Assign a case',
    permission: 'customers.verify',
    success: { status: 200, description: 'Assigned', data: caseSchema },
    errors: [404, 409, 422],
  },
  decide: {
    tag: ADMIN_REVIEW_TAG,
    summary: 'Decide a case',
    permission: 'customers.verify (MERGE also customers.merge)',
    description:
      'APPROVE_SEPARATE issues the Farm ID; MERGE links to the matched farm; REQUEST_CHANGES needs `issues[]`; REJECT closes it. Reviewer ≠ creator/owner (403 `SOD_VIOLATION`). Audited.',
    success: { status: 200, description: 'Resolved case', data: caseSchema },
    errors: [404, 409, 422],
  },
} satisfies Record<string, RouteDocs>;
