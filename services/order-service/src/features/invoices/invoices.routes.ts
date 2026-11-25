import { Readable } from 'node:stream';

import { AppError, UnauthorizedError } from '@farmx/common/errors';
import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { admin, rateLimit, requireAuth } from '../../middleware/guards.js';
import { actorOf } from '../audit/index.js';
import { fromBasisPoints, fromPaise } from '../pricing/index.js';
import { ADMIN_DOCS, CUSTOMER_DOCS } from './invoices.docs.js';
import type { DownloadResult } from './invoices.service.js';
import type { InvoiceSearch } from './invoices.types.js';
import {
  docParams,
  exportSchema,
  orderDocParams,
  orderParams,
  retrySchema,
  searchSchema,
} from './invoices.validation.js';
import { toDocumentView } from './invoices.views.js';

const svc = (req: FastifyRequest) => req.diScope.resolve('invoicesService');
const buyerId = (req: FastifyRequest): string => {
  if (req.user === null) throw new UnauthorizedError();
  return req.user.id;
};
const buyer = requireAuth('CUSTOMER');

/** PDF_NOT_READY → `Retry-After: 5` on the 409, so clients back off correctly. */
const withRetryAfter = async <T>(reply: FastifyReply, run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (err) {
    if (
      err instanceof AppError &&
      (err.details as { reason?: string } | undefined)?.reason === 'PDF_NOT_READY'
    )
      void reply.header('retry-after', '5');
    throw err;
  }
};

const sendDownload = (reply: FastifyReply, r: DownloadResult) =>
  r.kind === 'URL'
    ? reply
        .header('cache-control', 'private, no-store')
        .send(ok({ url: r.url, expiresAt: r.expiresAt }))
    : sendPdf(reply, r.file, r.fileName);

const sendPdf = (reply: FastifyReply, file: Buffer, fileName: string) =>
  reply
    .header('content-type', 'application/pdf')
    .header('content-disposition', `attachment; filename="${fileName}"`)
    .header('cache-control', 'private, no-store')
    .send(file);

/** Mounted at `/orders` (gateway: `/v1/orders`): the buyer's GST documents. */
export const invoicesRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>(
    '/:id/invoices',
    { schema: { ...orderParams, ...routeDocs(CUSTOMER_DOCS.list) }, preHandler: buyer },
    async (req) =>
      ok((await svc(req).listForOrder(req.params.id, buyerId(req))).map(toDocumentView)),
  );
  app.get<{ Params: { id: string } }>(
    '/:id/invoices/combined',
    {
      schema: { ...orderParams, ...routeDocs(CUSTOMER_DOCS.combined) },
      preHandler: [buyer, rateLimit('invoice-combined', 10, 60)],
    },
    async (req, reply) => {
      const pdf = await svc(req).combined(req.params.id, buyerId(req));
      return sendPdf(reply, pdf.file, pdf.fileName);
    },
  );
  app.get<{ Params: { id: string; docId: string } }>(
    '/:id/invoices/:docId/download',
    {
      schema: { ...orderDocParams, ...routeDocs(CUSTOMER_DOCS.download) },
      preHandler: [buyer, rateLimit('invoice-download', 30, 60)],
    },
    async (req, reply) =>
      sendDownload(
        reply,
        await withRetryAfter(reply, () =>
          svc(req).customerDownload(req.params.id, buyerId(req), req.params.docId),
        ),
      ),
  );
};

const write = (permission: string) => [...admin(permission), rateLimit('admin-invoices', 60, 60)];

const money = (p: bigint | number) => fromPaise(Number(p));

/** Mounted at `/admin/invoices` (gateway: `/v1/admin/invoices`). INTERNAL staff + MFA + permission. */
export const invoicesAdminRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: InvoiceSearch }>(
    '/',
    {
      schema: { ...searchSchema, ...routeDocs(ADMIN_DOCS.search) },
      preHandler: admin('invoices.view'),
    },
    async (req) => {
      const page = await svc(req).search(req.query);
      return paginated({ ...page, items: page.items.map(toDocumentView) });
    },
  );
  app.get<{ Querystring: { from: string; to: string } }>(
    '/export.csv',
    {
      schema: { ...exportSchema, ...routeDocs(ADMIN_DOCS.export) },
      preHandler: [...admin('invoices.export'), rateLimit('invoice-export', 5, 60)],
    },
    async (req, reply) => {
      const rows = svc(req).exportCsv(actorOf(req), req.query.from, req.query.to);
      // Pull the first chunk before sending headers: range errors still answer 422 JSON.
      const first = await rows.next();
      async function* all() {
        if (first.done !== true) yield first.value;
        yield* rows;
      }
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="gst-register-${req.query.from}_${req.query.to}.csv"`,
        )
        .header('cache-control', 'private, no-store')
        .send(Readable.from(all()));
    },
  );
  app.get<{ Params: { id: string } }>(
    '/:id',
    {
      schema: { ...docParams, ...routeDocs(ADMIN_DOCS.detail) },
      preHandler: admin('invoices.view'),
    },
    async (req) => {
      const { doc, linked } = await svc(req).detail(req.params.id);
      const { lines, ...d } = doc;
      return ok({
        ...toDocumentView(d as never),
        fy: d.fy,
        series: d.series,
        userId: d.userId,
        farmId: d.farmId,
        sellerGstin: d.sellerGstin,
        sellerStateCode: d.sellerStateCode,
        reverseCharge: d.reverseCharge,
        cgst: money(d.cgstPaise),
        sgst: money(d.sgstPaise),
        igst: money(d.igstPaise),
        roundOff: money(d.roundOffPaise),
        amountInWords: d.amountInWords,
        reason: d.reason,
        issuedBy: d.issuedBy,
        irn: d.irn,
        pdf: {
          status: d.pdfStatus,
          attempts: d.pdfAttempts,
          error: d.pdfError,
          renderedAt: d.pdfRenderedAt,
        },
        snapshotSha256: d.snapshotSha256,
        snapshot: d.snapshot,
        lines: lines.map((l) => ({
          lineNo: l.lineNo,
          kind: l.kind,
          orderLineNo: l.orderLineNo,
          sku: l.sku,
          description: l.description,
          hsnSac: l.hsnSac,
          qty: l.qty,
          unitPrice: money(l.unitPricePaise),
          gross: money(l.grossPaise),
          discount: money(l.discountPaise),
          taxable: money(l.taxablePaise),
          gstRate: fromBasisPoints(l.gstRateBp),
          cgst: money(l.cgstPaise),
          sgst: money(l.sgstPaise),
          igst: money(l.igstPaise),
          total: money(l.totalPaise),
        })),
        linked: linked.map(toDocumentView),
      });
    },
  );
  app.get<{ Params: { id: string } }>(
    '/:id/download',
    {
      schema: { ...docParams, ...routeDocs(ADMIN_DOCS.download) },
      preHandler: write('invoices.view'),
    },
    async (req, reply) =>
      sendDownload(
        reply,
        await withRetryAfter(reply, () => svc(req).adminDownload(actorOf(req), req.params.id)),
      ),
  );
  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/:id/pdf/retry',
    {
      schema: { ...retrySchema, ...routeDocs(ADMIN_DOCS.retry) },
      preHandler: write('invoices.view'),
    },
    async (req) => ok(await svc(req).retryPdf(actorOf(req), req.params.id, req.body.reason)),
  );
};
