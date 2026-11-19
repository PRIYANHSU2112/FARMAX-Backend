import type Joi from 'joi';

import type { ErrorStatus } from './components.js';

/** A request or response header, documented only (never validated by these docs). */
export interface DocHeader {
  description: string;
  required?: boolean;
  /** JSON schema of the value; defaults to `{ type: 'string' }`. */
  schema?: Record<string, unknown>;
}

/** Route-specific example of an error body (`code` comes from the status). */
export interface ErrorExample {
  /** Short label in Swagger UI's example dropdown (needed when a status has several). */
  summary?: string;
  message: string;
  details?: unknown;
}

export interface RouteDocs {
  /** Section in Swagger UI, e.g. `Admin Users`. */
  tag: string;
  summary: string;
  description?: string;
  /** Unique, stable id for client generators (e.g. `getMyFarm`). */
  operationId?: string;
  /** Who may call the route (persona, token scope, ownership). Shown in the description. */
  auth?: string;
  /** Required permission key. Shown in the description; the route gets the lock (bearerAuth). */
  permission?: string;
  /** Rate limit, e.g. `10 per user per 24 h`. Shown in the description. */
  rateLimit?: string;
  /** Public route: no lock, no 401/403. */
  public?: boolean;
  /** Request headers the handler reads (e.g. `If-Match`, `Idempotency-Key`). Docs only. */
  headers?: Readonly<Record<string, DocHeader>>;
  /** Example request body. */
  requestExample?: unknown;
  success: {
    status: 200 | 201 | 204;
    description: string;
    /** Schema of `data` (Joi with `.meta({ className })` becomes a reusable `$ref`). */
    data?: Joi.Schema;
    /** `data` is an array and `meta` holds `{ nextCursor, limit }`. */
    paginated?: boolean;
    /** Example of the whole response body. */
    example?: unknown;
    /** Response headers (e.g. `ETag`, `Cache-Control`). */
    headers?: Readonly<Record<string, DocHeader>>;
  };
  /** multipart/form-data with one binary `file` field (documented via the FileUpload component). */
  fileUpload?: boolean;
  /** Route-specific errors (400, 404, 409, 422, 503). 401/403/429/500 are added automatically. */
  errors?: readonly ErrorStatus[];
  /** Route-specific error examples; replace the generic example of the shared response. */
  errorExamples?: Partial<Record<ErrorStatus, ErrorExample | readonly ErrorExample[]>>;
}

/** Marker read by the docs transform: wrap `data` in the `{ success, data, meta? }` envelope. */
export const ENVELOPE_KEY = 'x-farmx-envelope';
export const ERRORS_KEY = 'x-errors';
export const FILE_UPLOAD_KEY = 'x-file-upload';
export const ERROR_EXAMPLES_KEY = 'x-error-examples';
export const HEADERS_KEY = 'x-doc-headers';
export const REQUEST_EXAMPLE_KEY = 'x-request-example';

/** `{ 'If-Match': {...} }` → the JSON-schema form @fastify/swagger turns into header params. */
export const headersToJsonSchema = (headers: Readonly<Record<string, DocHeader>>) => ({
  type: 'object',
  properties: Object.fromEntries(
    Object.entries(headers).map(([name, header]) => [
      name,
      { ...(header.schema ?? { type: 'string' }), description: header.description },
    ]),
  ),
  required: Object.entries(headers)
    .filter(([, header]) => header.required === true)
    .map(([name]) => name),
});

/**
 * Swagger metadata for a route. Spread it into the route's `schema` next to the Joi request
 * schemas: `schema: { ...listUsersSchema, ...routeDocs({...}) }`.
 * Response schemas are documentation only (responses are serialised with JSON.stringify).
 */
export function routeDocs(docs: RouteDocs): Record<string, unknown> {
  const automatic: ErrorStatus[] = docs.public === true ? [429, 500] : [401, 403, 429, 500];
  const errors = [...new Set([...(docs.errors ?? []), ...automatic])].sort((a, b) => a - b);
  const description = [
    docs.description,
    docs.auth === undefined ? undefined : `**Auth:** ${docs.auth}`,
    docs.permission === undefined ? undefined : `**Permission:** \`${docs.permission}\``,
    docs.rateLimit === undefined
      ? undefined
      : `**Rate limit:** ${docs.rateLimit} (429 + \`Retry-After\`)`,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n\n');
  const successHeaders =
    docs.success.headers === undefined
      ? {}
      : {
          headers: Object.fromEntries(
            Object.entries(docs.success.headers).map(([name, header]) => [
              name,
              { ...(header.schema ?? { type: 'string' }), description: header.description },
            ]),
          ),
        };

  return {
    ...(docs.operationId === undefined ? {} : { operationId: docs.operationId }),
    tags: [docs.tag],
    summary: docs.summary,
    ...(description === '' ? {} : { description }),
    ...(docs.public === true ? {} : { security: [{ bearerAuth: [] }] }),
    response: {
      [docs.success.status]:
        docs.success.status === 204
          ? { description: docs.success.description, type: 'null', ...successHeaders }
          : {
              [ENVELOPE_KEY]: true,
              description: docs.success.description,
              data: docs.success.data,
              paginated: docs.success.paginated === true,
              example: docs.success.example,
              ...successHeaders,
            },
    },
    [ERRORS_KEY]: errors,
    ...(docs.errorExamples === undefined ? {} : { [ERROR_EXAMPLES_KEY]: docs.errorExamples }),
    ...(docs.headers === undefined ? {} : { [HEADERS_KEY]: docs.headers }),
    ...(docs.requestExample === undefined ? {} : { [REQUEST_EXAMPLE_KEY]: docs.requestExample }),
    ...(docs.fileUpload === true ? { [FILE_UPLOAD_KEY]: true } : {}),
  };
}
