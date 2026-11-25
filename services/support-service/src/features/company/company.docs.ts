import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, AUTH_PUBLIC, AUTH_REQUESTER, IDS } from '../../docs/shared.js';
import { APPLICATION_STATUSES, APPLICATION_TYPES, COMPANY_DOC_TYPES } from './company.types.js';

export const COMPANY_TAG = 'Company';
export const ADMIN_COMPANY_TAG = 'Admin Company';

const DOC_ID = '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a0c';
const APPLICATION_ID = '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a0d';

const publicDocSchema = Joi.object({
  id: Joi.string().guid().example(DOC_ID),
  type: Joi.string()
    .valid(...COMPANY_DOC_TYPES)
    .example('DRUG_LICENSE'),
  title: Joi.string().example('CDSCO Drug Licence (Form 20B / 21B)'),
  documentNo: Joi.string().example('AP/WHL/2024/00123'),
  issuingAuthority: Joi.string().example('Drugs Control Administration, Andhra Pradesh'),
  expiresAt: Joi.date().iso().allow(null).description('null = no expiry'),
  fileUrl: Joi.string().uri().example('https://cdn.farmx.in/company/drug-licence.pdf'),
  updatedAt: Joi.date().iso(),
}).meta({ className: 'CompanyDocumentPublic' });

const docSchema = publicDocSchema
  .keys({
    isPublic: Joi.boolean().description('Shown in the apps when true (and not expired)'),
    createdBy: Joi.string().guid(),
    updatedBy: Joi.string().guid().allow(null),
    createdAt: Joi.date().iso(),
  })
  .meta({ className: 'CompanyDocument' });

const attachedDocSchema = Joi.object({
  fileName: Joi.string().allow(null).example('gst-certificate.pdf'),
  mime: Joi.string().example('application/pdf'),
  size: Joi.number().integer().example(482113),
  url: Joi.string()
    .uri()
    .allow(null)
    .description('Signed URL, valid 5 minutes (null when the file is gone)'),
}).meta({ className: 'ApplicationAttachment' });

const applicationFields = {
  id: Joi.string().guid().example(APPLICATION_ID),
  applicantUserId: Joi.string().guid().example(IDS.user),
  businessName: Joi.string().example('Sri Lakshmi Poultry Agencies'),
  applicationType: Joi.string()
    .valid(...APPLICATION_TYPES)
    .example('DEALER'),
  status: Joi.string()
    .valid(...APPLICATION_STATUSES)
    .example('SUBMITTED'),
  reviewNotes: Joi.string().allow(null).description('Reason shown to the applicant on rejection'),
  reviewedAt: Joi.date().iso().allow(null),
  createdAt: Joi.date().iso(),
  updatedAt: Joi.date().iso(),
};

const myApplicationSchema = Joi.object({
  ...applicationFields,
  attachedDocs: Joi.array().items(attachedDocSchema),
}).meta({ className: 'MyCompanyApplication' });

const applicationSchema = Joi.object({
  ...applicationFields,
  reviewedBy: Joi.string().guid().allow(null),
  attachedDocs: Joi.array().items(attachedDocSchema),
}).meta({ className: 'CompanyApplication' });

const applicationSummarySchema = Joi.object({
  ...applicationFields,
  reviewedBy: Joi.string().guid().allow(null),
  attachmentCount: Joi.number().integer().example(2),
}).meta({ className: 'CompanyApplicationSummary' });

const applicationDetailSchema = applicationSchema
  .keys({
    applicant: Joi.object({
      id: Joi.string().guid(),
      userType: Joi.string().example('CUSTOMER'),
      status: Joi.string().example('ACTIVE'),
      fullName: Joi.string().example('K. Ramesh'),
      phone: Joi.string().allow(null).example('+919876543210'),
    })
      .allow(null)
      .description('From auth-service; null when it is unreachable'),
  })
  .meta({ className: 'CompanyApplicationDetail' });

const req = { tag: COMPANY_TAG, auth: AUTH_REQUESTER } as const;
const docsAdm = { tag: ADMIN_COMPANY_TAG, auth: AUTH_ADMIN, permission: 'legal.manage' } as const;
const docsWrite = { ...docsAdm, rateLimit: '120 writes per user per minute' } as const;
const appsAdm = { tag: ADMIN_COMPANY_TAG, auth: AUTH_ADMIN, permission: 'support.view' } as const;

export const COMPANY_DOCS = {
  publicDocs: {
    tag: COMPANY_TAG,
    public: true,
    auth: AUTH_PUBLIC,
    summary: 'Company licences and certificates',
    description:
      'Public, unexpired documents (CDSCO drug licence, GST, COI, FSSAI, ISO …), grouped by type. Cached; send `If-None-Match` with the last `ETag` → 304 when unchanged.',
    headers: { 'If-None-Match': { description: 'ETag of the copy the app holds' } },
    success: {
      status: 200,
      description: 'Documents',
      data: Joi.array().items(publicDocSchema),
      headers: { ETag: { description: 'Hash of the list' } },
    },
  },
  apply: {
    ...req,
    summary: 'Apply to become a dealer / distributor / partner',
    description:
      'Upload each supporting document first (`POST /v1/upload?purpose=support`) and send the receipts. One open (SUBMITTED) application per type: a second one answers 409. The applicant is notified when staff approve or reject it.',
    rateLimit: '5 per user per hour',
    requestExample: {
      businessName: 'Sri Lakshmi Poultry Agencies',
      applicationType: 'DEALER',
      attachments: ['<receipt from POST /v1/upload?purpose=support>'],
    },
    success: { status: 201, description: 'Submitted', data: myApplicationSchema },
    errors: [409, 422, 503],
  },
  mine: {
    ...req,
    summary: 'My applications (track status)',
    description: 'Newest first (last 50). File URLs are signed for 5 minutes.',
    rateLimit: '120 per user per minute',
    success: {
      status: 200,
      description: 'Applications',
      data: Joi.array().items(myApplicationSchema),
    },
    errors: [503],
  },
  listDocs: {
    ...docsAdm,
    summary: 'List company documents',
    description: 'Every document, public or not, expired or not. Filter by `type` / `isPublic`.',
    success: { status: 200, description: 'Documents', data: Joi.array().items(docSchema) },
    errors: [422],
  },
  createDoc: {
    ...docsWrite,
    summary: 'Add a company document',
    description:
      'Upload the file first (`POST /v1/upload`, public) and send its URL. Hidden from apps until `isPublic` is true. Audited; refreshes the public cache.',
    requestExample: {
      type: 'DRUG_LICENSE',
      title: 'CDSCO Drug Licence (Form 20B / 21B)',
      documentNo: 'AP/WHL/2024/00123',
      issuingAuthority: 'Drugs Control Administration, Andhra Pradesh',
      expiresAt: '2029-03-31',
      fileUrl: 'https://cdn.farmx.in/company/drug-licence.pdf',
      isPublic: true,
    },
    success: { status: 201, description: 'Created', data: docSchema },
    errors: [422],
  },
  updateDoc: {
    ...docsWrite,
    summary: 'Edit a company document',
    description: 'Any subset of fields. Audited (before / after); refreshes the public cache.',
    requestExample: { expiresAt: '2030-03-31', isPublic: true },
    success: { status: 200, description: 'Updated', data: docSchema },
    errors: [404, 422],
  },
  deleteDoc: {
    ...docsWrite,
    summary: 'Delete a company document',
    description: 'Needs `reason`. Audited; refreshes the public cache.',
    requestExample: { reason: 'Superseded by the renewed licence' },
    success: { status: 204, description: 'Deleted' },
    errors: [404, 422],
  },
  queue: {
    ...appsAdm,
    summary: 'Application review queue',
    description:
      'Oldest first. Filter `status` (e.g. SUBMITTED for the pending queue) and `type`. `cursor` = `nextCursor` of the previous page.',
    success: {
      status: 200,
      description: 'Applications',
      data: Joi.array().items(applicationSummarySchema),
      paginated: true,
    },
    errors: [422],
  },
  detail: {
    ...appsAdm,
    summary: 'Application detail',
    description: "Signed file URLs (5 minutes) and the applicant's name / phone.",
    success: { status: 200, description: 'Application', data: applicationDetailSchema },
    errors: [404, 503],
  },
  review: {
    ...appsAdm,
    permission: 'support.manage',
    rateLimit: '120 writes per user per minute',
    summary: 'Approve or reject an application',
    description:
      'SUBMITTED → APPROVED | REJECTED (final). `reviewNotes` is required when rejecting and is shown to the applicant. You cannot review your own application. Audited; emits `support.application_status_changed.v1` (applicant push).',
    requestExample: {
      status: 'REJECTED',
      reviewNotes: 'GST certificate is not readable; please re-apply.',
    },
    success: { status: 200, description: 'Reviewed', data: applicationSchema },
    errors: [403, 404, 409, 422],
  },
} satisfies Record<string, RouteDocs>;
