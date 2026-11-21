import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, AUTH_PUBLIC, AUTH_REQUESTER } from '../../docs/shared.js';
import { APPS } from '../../middleware/http.js';

export const FAQ_TAG = 'FAQs';
export const ADMIN_FAQ_TAG = 'Admin FAQs';

const categorySchema = Joi.object({
  id: Joi.string().guid(),
  app: Joi.string().valid(...APPS),
  code: Joi.string().example('MEMBERSHIP'),
  title: Joi.string().example('Membership'),
  sortOrder: Joi.number().integer(),
  isActive: Joi.boolean(),
}).meta({ className: 'FaqCategory' });

const faqSchema = Joi.object({
  id: Joi.string().guid(),
  app: Joi.string().valid(...APPS),
  categoryId: Joi.string().guid(),
  question: Joi.string().example('Can I cancel my membership anytime?'),
  answer: Joi.string().example('Yes. Cancel anytime from Profile → Membership. No cancellation fee.'),
  tags: Joi.array().items(Joi.string()),
  topicCodes: Joi.array().items(Joi.string()).description('Ticket topics this FAQ answers'),
  sortOrder: Joi.number().integer(),
  helpfulCount: Joi.number().integer(),
  notHelpfulCount: Joi.number().integer(),
}).meta({ className: 'Faq' });

const faqAdminSchema = faqSchema.keys({ isActive: Joi.boolean(), createdAt: Joi.date().iso(), updatedAt: Joi.date().iso() }).meta({ className: 'FaqAdmin' });

const pub = { tag: FAQ_TAG, public: true, auth: AUTH_PUBLIC } as const;
const adm = { tag: ADMIN_FAQ_TAG, auth: AUTH_ADMIN, permission: 'faq.manage' } as const;
const admWrite = { ...adm, rateLimit: '120 writes per user per minute' } as const;

export const FAQ_DOCS = {
  categories: { ...pub, summary: 'FAQ categories of an app', description: 'Active categories in display order. Cached.', success: { status: 200, description: 'Categories', data: Joi.array().items(categorySchema) }, errors: [422] },
  list: {
    ...pub,
    summary: 'List or search FAQs',
    description: 'Without `q`: display order (optionally one category). With `q` ("Search your question"): English full-text search, best match first. `cursor` is the opaque `nextCursor` of the previous page. Cached per content version.',
    success: { status: 200, description: 'FAQs', data: Joi.array().items(faqSchema), paginated: true },
    errors: [422],
  },
  suggestions: {
    tag: FAQ_TAG,
    public: true,
    auth: AUTH_PUBLIC,
    summary: 'These may answer it (ticket deflection)',
    description: 'Up to 3 FAQs for the chosen topic: matching the typed text (≥ 3 chars) first, else the topic\'s most helpful. Call while the user types (debounced).',
    success: { status: 200, description: 'Suggestions', data: Joi.array().items(faqSchema) },
    errors: [422],
  },
  feedback: {
    tag: FAQ_TAG,
    auth: AUTH_REQUESTER,
    summary: 'Was this helpful?',
    description: 'One vote per user per FAQ; voting again changes it. Concurrent taps are serialised.',
    rateLimit: '30 per user per minute',
    requestExample: { helpful: true },
    success: { status: 200, description: 'Vote saved', data: Joi.object({ faqId: Joi.string().guid(), helpful: Joi.boolean(), changed: Joi.boolean(), helpfulCount: Joi.number(), notHelpfulCount: Joi.number() }) },
    errors: [404, 422],
  },
  adminCategories: { ...adm, summary: 'List FAQ categories', description: 'Inactive included.', success: { status: 200, description: 'Categories', data: Joi.array().items(categorySchema) } },
  createCategory: { ...admWrite, summary: 'Add an FAQ category', description: '`code` and `app` never change. Audited.', requestExample: { app: 'CUSTOMER', code: 'MEMBERSHIP', title: 'Membership', sortOrder: 1 }, success: { status: 201, description: 'Created', data: categorySchema }, errors: [409, 422] },
  updateCategory: { ...admWrite, summary: 'Edit or hide an FAQ category', description: 'Hiding a category hides its FAQs. Audited.', success: { status: 200, description: 'Updated', data: categorySchema }, errors: [404, 422] },
  adminList: { ...adm, summary: 'List FAQs (admin)', description: 'Inactive included; filter by `app` / `categoryId`.', success: { status: 200, description: 'FAQs', data: Joi.array().items(faqAdminSchema) } },
  createFaq: {
    ...admWrite,
    summary: 'Add an FAQ',
    description: '`topicCodes` link it to ticket topics for "These may answer it". Audited; apps see it within seconds.',
    requestExample: { app: 'CUSTOMER', categoryId: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a08', question: 'Is there a lock-in period?', answer: 'No. Cancel anytime.', topicCodes: ['PAYMENT'] },
    success: { status: 201, description: 'Created', data: faqAdminSchema },
    errors: [422],
  },
  updateFaq: { ...admWrite, summary: 'Edit or hide an FAQ', description: 'Audited.', success: { status: 200, description: 'Updated', data: faqAdminSchema }, errors: [404, 422] },
  reorder: { ...admWrite, summary: 'Reorder FAQs', description: '`ids` in the new display order (one statement). Audited.', requestExample: { app: 'CUSTOMER', ids: ['0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7a07'] }, success: { status: 200, description: 'Rows updated', data: Joi.object({ updated: Joi.number().integer() }) }, errors: [422] },
} satisfies Record<string, RouteDocs>;
