import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync } from 'fastify';

import { admin, customer, rateLimit } from '../../middleware/guards.js';
import { actorOf } from '../audit/index.js';
import { KYC_DOCS } from './kyc.docs.js';
import type { BillingInput, DocumentDecisionInput, DocumentInput } from './kyc.types.js';
import {
  aadhaarOtpSchema,
  aadhaarVerifySchema,
  adminDocsSchema,
  billingSchema,
  documentDecisionSchema,
  documentSchema,
  gstinSchema,
  panSchema,
} from './kyc.validation.js';

interface P {
  id: string;
}

/** Mounted at `/farms`: `/farms/:id/kyc/*` and `/farms/:id/billing`. */
export const kycRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: P; Body: { aadhaarNumber: string } }>(
    '/:id/kyc/aadhaar/otp',
    {
      schema: { ...aadhaarOtpSchema, ...routeDocs(KYC_DOCS.aadhaarOtp) },
      preHandler: [...customer, rateLimit('aadhaar-otp', 3, 3_600)],
    },
    async (req) =>
      ok(
        await req.diScope
          .resolve('kycService')
          .sendAadhaarOtp(actorOf(req), req.params.id, req.body.aadhaarNumber),
      ),
  );
  app.post<{ Params: P; Body: { txnRef: string; otp: string } }>(
    '/:id/kyc/aadhaar/verify',
    {
      schema: { ...aadhaarVerifySchema, ...routeDocs(KYC_DOCS.aadhaarVerify) },
      preHandler: [...customer, rateLimit('aadhaar-verify', 10, 3_600)],
    },
    async (req) =>
      ok(
        await req.diScope
          .resolve('kycService')
          .verifyAadhaarOtp(actorOf(req), req.params.id, req.body.txnRef, req.body.otp),
      ),
  );
  app.put<{ Params: P; Body: { pan: string } }>(
    '/:id/kyc/pan',
    {
      schema: { ...panSchema, ...routeDocs(KYC_DOCS.pan) },
      preHandler: [...customer, rateLimit('pan', 5, 3_600)],
    },
    async (req) =>
      ok(await req.diScope.resolve('kycService').setPan(actorOf(req), req.params.id, req.body.pan)),
  );
  app.post<{ Params: P; Body: DocumentInput }>(
    '/:id/kyc/documents',
    {
      schema: { ...documentSchema, ...routeDocs(KYC_DOCS.document) },
      preHandler: [...customer, rateLimit('kyc-doc', 20, 3_600)],
    },
    async (req, reply) =>
      reply
        .code(201)
        .send(
          ok(
            await req.diScope
              .resolve('kycService')
              .addDocument(actorOf(req), req.params.id, req.body),
          ),
        ),
  );
  app.post<{ Params: P; Body: { gstin: string } }>(
    '/:id/kyc/gstin/verify',
    {
      schema: { ...gstinSchema, ...routeDocs(KYC_DOCS.gstin) },
      preHandler: [...customer, rateLimit('gstin', 10, 3_600)],
    },
    async (req) =>
      ok(
        await req.diScope
          .resolve('kycService')
          .verifyGstin(actorOf(req), req.params.id, req.body.gstin),
      ),
  );
  app.put<{ Params: P; Body: BillingInput }>(
    '/:id/billing',
    { schema: { ...billingSchema, ...routeDocs(KYC_DOCS.billing) }, preHandler: customer },
    async (req) =>
      ok(await req.diScope.resolve('kycService').setBilling(actorOf(req), req.params.id, req.body)),
  );
};

/** Mounted at `/admin/farms`. */
export const kycAdminRoutes: FastifyPluginAsync = async (app) => {
  const guard = admin('customers.verify');
  app.get<{ Params: P }>(
    '/:id/kyc/documents',
    { schema: { ...adminDocsSchema, ...routeDocs(KYC_DOCS.adminDocs) }, preHandler: guard },
    async (req) => ok(await req.diScope.resolve('kycService').listDocuments(req.params.id)),
  );
  app.post<{ Params: P & { docId: string }; Body: DocumentDecisionInput }>(
    '/:id/kyc/documents/:docId/decision',
    {
      schema: { ...documentDecisionSchema, ...routeDocs(KYC_DOCS.adminDecide) },
      preHandler: guard,
    },
    async (req) =>
      ok(
        await req.diScope
          .resolve('kycService')
          .decideDocument(actorOf(req), req.params.id, req.params.docId, req.body),
      ),
  );
};
