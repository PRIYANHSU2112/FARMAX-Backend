import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, AUTH_PUBLIC } from '../../docs/shared.js';
import { APPS } from '../../middleware/http.js';
import { LEGAL_KINDS } from './legal.types.js';

export const LEGAL_TAG = 'Legal';
export const ADMIN_LEGAL_TAG = 'Admin Legal';

const legalSchema = Joi.object({
  id: Joi.string().guid(),
  kind: Joi.string().valid(...LEGAL_KINDS),
  app: Joi.string()
    .valid(...APPS)
    .allow(null)
    .description('null = every app'),
  version: Joi.number().integer(),
  title: Joi.string().example('Privacy Policy'),
  intro: Joi.string().allow(null).example('FarmX is committed to protecting your personal data.'),
  sections: Joi.array().items(
    Joi.object({ heading: Joi.string().example('Information Sharing'), body: Joi.string() }),
  ),
  status: Joi.string().valid('DRAFT', 'PUBLISHED', 'ARCHIVED'),
  effectiveFrom: Joi.date().iso().allow(null),
  publishedAt: Joi.date().iso().allow(null),
  publishedBy: Joi.string().guid().allow(null),
  updatedAt: Joi.date().iso(),
}).meta({ className: 'LegalDocument' });

const adm = { tag: ADMIN_LEGAL_TAG, auth: AUTH_ADMIN, permission: 'legal.manage' } as const;
const admWrite = { ...adm, rateLimit: '120 writes per user per minute' } as const;

export const LEGAL_DOCS = {
  published: {
    tag: LEGAL_TAG,
    public: true,
    auth: AUTH_PUBLIC,
    summary: 'Read a legal page (Privacy Policy, Terms …)',
    description:
      'The published version for the app (falls back to the all-apps version). Sections render as the accordion. Send `If-None-Match` with the last `ETag` → 304 when unchanged. Contact card: `GET /v1/support/config`.',
    headers: { 'If-None-Match': { description: 'ETag of the copy the app holds' } },
    success: {
      status: 200,
      description: 'Document',
      data: legalSchema,
      headers: { ETag: { description: '"<id>.<version>"' } },
    },
    errors: [404, 422],
  },
  list: {
    ...adm,
    summary: 'List legal document versions',
    description: 'Every version (draft, published, archived), newest first.',
    success: { status: 200, description: 'Versions', data: Joi.array().items(legalSchema) },
  },
  createDraft: {
    ...admWrite,
    summary: 'Create a draft version',
    description:
      'Next version number for (kind, app). Drafts are invisible to apps until published. Audited.',
    requestExample: {
      kind: 'PRIVACY_POLICY',
      app: null,
      title: 'Privacy Policy',
      intro: 'FarmX is committed to protecting your personal data.',
      sections: [{ heading: 'Information We Collect', body: 'Name, phone, farm details …' }],
    },
    success: { status: 201, description: 'Draft', data: legalSchema },
    errors: [422],
  },
  updateDraft: {
    ...admWrite,
    summary: 'Edit a draft',
    description: 'Published / archived versions are immutable (409). Audited.',
    success: { status: 200, description: 'Draft', data: legalSchema },
    errors: [404, 409, 422],
  },
  publish: {
    ...admWrite,
    summary: 'Publish a draft',
    description:
      'Archives the live version of the same (kind, app) and publishes this one atomically (a unique index allows only one live version). Needs `reason`. Audited.',
    requestExample: { reason: 'Annual review' },
    success: { status: 200, description: 'Published', data: legalSchema },
    errors: [404, 409, 422],
  },
} satisfies Record<string, RouteDocs>;
