import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';

import {
  ERROR_HEADERS,
  ERROR_RESPONSES,
  ERROR_STATUS_CODES,
  type ErrorStatus,
  sharedComponents,
} from './components.js';
import {
  ERRORS_KEY,
  ERROR_EXAMPLES_KEY,
  type ErrorExample,
  FILE_UPLOAD_KEY,
} from './route-docs.js';
import { type ComponentRegistry, createDocsTransform } from './transform.js';
import { DOCS_UI_CSS, DOCS_UI_SCRIPT } from './ui-script.js';

export interface DocsServer {
  url: string;
  description: string;
}

export interface DocsTag {
  name: string;
  description: string;
}

export interface DocsOptions {
  title: string;
  version: string;
  description?: string;
  /** Server dropdown in Swagger UI (e.g. local, production), usually from env. */
  servers?: readonly DocsServer[];
  /** Sections, in display order. Tags without routes are listed as "coming soon". */
  tags?: readonly DocsTag[];
  /** Swagger UI path. The spec is also served at `<routePrefix>.json` (Postman import). */
  routePrefix?: string;
}

type JsonObject = Record<string, unknown>;
type Operation = JsonObject & {
  tags?: string[];
  responses?: JsonObject;
  [ERRORS_KEY]?: ErrorStatus[];
  [ERROR_EXAMPLES_KEY]?: Partial<Record<ErrorStatus, ErrorExample | readonly ErrorExample[]>>;
  [FILE_UPLOAD_KEY]?: boolean;
};

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

const operationsOf = (paths: unknown): Operation[] =>
  Object.values((paths ?? {}) as Record<string, JsonObject>).flatMap((item) =>
    Object.entries(item)
      .filter(([method]) => HTTP_METHODS.has(method))
      .map(([, operation]) => operation as Operation),
  );

const EXAMPLE_REQUEST_ID = '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e6f';

/** Inline error response: the shared description + schema, with this route's own examples. */
const errorWithExamples = (
  status: ErrorStatus,
  custom: ErrorExample | readonly ErrorExample[],
): JsonObject => {
  const shared = sharedComponents().responses[ERROR_RESPONSES[status]];
  const list: readonly ErrorExample[] = Array.isArray(custom)
    ? (custom as readonly ErrorExample[])
    : [custom as ErrorExample];
  const body = (example: ErrorExample) => ({
    success: false,
    error: {
      code: ERROR_STATUS_CODES[status],
      message: example.message,
      ...(example.details === undefined ? {} : { details: example.details }),
      requestId: EXAMPLE_REQUEST_ID,
    },
  });
  const schema = status === 422 ? 'ValidationErrorBody' : 'ErrorBody';
  return {
    description: shared.description,
    ...(ERROR_HEADERS[status] === undefined ? {} : { headers: ERROR_HEADERS[status] }),
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${schema}` },
        examples: Object.fromEntries(
          list.map((example, i) => [
            `e${String(i + 1)}`,
            { summary: example.summary ?? example.message, value: body(example) },
          ]),
        ),
      },
    },
  };
};

/** Quick links (Swagger UI deep links `#/<Tag>`) to every section that has routes. */
const quickLinks = (tags: readonly DocsTag[], used: ReadonlySet<string>): string => {
  const links = tags
    .filter((tag) => used.has(tag.name))
    .map((tag) => `[${tag.name}](#/${encodeURIComponent(tag.name)})`);
  const soon = tags.filter((tag) => !used.has(tag.name)).map((tag) => tag.name);
  return [
    links.length > 0 ? `**Jump to:** ${links.join(' · ')}` : '',
    soon.length > 0 ? `_Coming soon: ${soon.join(', ')}_` : '',
    '🔒 = needs a Bearer token (click **Authorize**). Routes without a lock are public.',
  ]
    .filter((line) => line !== '')
    .join('\n\n');
};

/**
 * Final pass over the generated document:
 * - adds the Joi-generated components (shared ones win on a name clash);
 * - turns each route's `x-errors` list into `$ref`s to the shared error responses;
 * - writes the quick links into `info.description`.
 */
const finalize = (
  doc: JsonObject,
  registry: ComponentRegistry,
  options: DocsOptions,
): JsonObject => {
  const components = (doc.components ?? {}) as JsonObject & { schemas?: JsonObject };
  components.schemas = { ...Object.fromEntries(registry), ...(components.schemas ?? {}) };
  doc.components = components;

  const used = new Set<string>();
  for (const operation of operationsOf(doc.paths)) {
    for (const tag of operation.tags ?? []) used.add(tag);
    if (operation[FILE_UPLOAD_KEY] === true) {
      operation.requestBody = { $ref: '#/components/requestBodies/FileUpload' };
      Reflect.deleteProperty(operation, FILE_UPLOAD_KEY);
    }
    const errors = operation[ERRORS_KEY];
    const examples = operation[ERROR_EXAMPLES_KEY] ?? {};
    if (errors !== undefined) {
      const responses = operation.responses ?? {};
      for (const status of errors) {
        const custom = examples[status];
        responses[String(status)] =
          custom === undefined
            ? { $ref: `#/components/responses/${ERROR_RESPONSES[status]}` }
            : errorWithExamples(status, custom);
      }
      operation.responses = responses;
      Reflect.deleteProperty(operation, ERRORS_KEY);
    }
    Reflect.deleteProperty(operation, ERROR_EXAMPLES_KEY);
  }

  const info = (doc.info ?? {}) as JsonObject;
  const tags = options.tags ?? [];
  info.description = [options.description, quickLinks(tags, used)].filter(Boolean).join('\n\n');
  doc.info = info;
  return doc;
};

/**
 * OpenAPI 3.0.3 spec from route schemas, served as JSON at `/api-docs.json` (no UI).
 * There is ONE Swagger UI for the whole platform: the api-gateway merges every service's spec
 * and serves it with `registerDocsUi` (D-29).
 */
export const registerDocs = async (app: FastifyInstance, options: DocsOptions): Promise<void> => {
  const routePrefix = options.routePrefix ?? '/api-docs';
  const registry: ComponentRegistry = new Map();

  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: { title: options.title, version: options.version },
      servers: (options.servers ?? []).map((server) => ({ ...server })),
      tags: (options.tags ?? []).map((tag) => ({ ...tag })),
      components: sharedComponents() as never,
    },
    transform: createDocsTransform(registry) as never,
    transformObject: ((input: { openapiObject: JsonObject }) =>
      finalize(input.openapiObject, registry, options)) as never,
  });

  // Read by the gateway's docs aggregator (and Postman: Import → Link → <server>/api-docs.json).
  app.get(`${routePrefix}.json`, { schema: { hide: true }, logLevel: 'silent' }, () =>
    app.swagger(),
  );
};

export interface DocsUiOptions {
  /** Browser tab title. */
  title: string;
  /** Swagger UI path (default `/api-docs`); the spec is also served at `<routePrefix>.json`. */
  routePrefix?: string;
  /** Returns the (merged) OpenAPI document; called per spec request, so cache inside it. */
  load: () => Promise<Record<string, unknown>>;
}

/**
 * The single Swagger UI (api-gateway): serves whatever `load()` returns, with the FarmX theme
 * (JWT banner, quick links). Register inside a plugin (e.g. a module's routes).
 */
export const registerDocsUi = async (
  app: FastifyInstance,
  options: DocsUiOptions,
): Promise<void> => {
  const routePrefix = options.routePrefix ?? '/api-docs';
  // @fastify/swagger in static mode always returns THIS object, so refreshing it in place makes
  // swagger-ui's synchronous `fastify.swagger()` serve the latest merged spec.
  const document: Record<string, unknown> = {
    openapi: '3.0.3',
    info: { title: options.title, version: '0' },
    paths: {},
  };
  const refresh = async (): Promise<Record<string, unknown>> => {
    const latest = await options.load();
    for (const key of Object.keys(document)) Reflect.deleteProperty(document, key);
    Object.assign(document, latest);
    return document;
  };

  await app.register(swagger, { mode: 'static', specification: { document: document as never } });
  await app.register(swaggerUi, {
    routePrefix,
    uiHooks: {
      // Callback-style hook (that is what the swagger-ui types declare).
      preHandler: (request, _reply, done) => {
        if (!(request.url.split('?')[0] ?? '').endsWith('/json')) {
          done();
          return;
        }
        refresh().then(
          () => {
            done();
          },
          (error: unknown) => {
            done(error instanceof Error ? error : new Error(String(error)));
          },
        );
      },
    },
    uiConfig: {
      deepLinking: true,
      docExpansion: 'none',
      filter: true,
      persistAuthorization: true,
      displayRequestDuration: true,
      defaultModelsExpandDepth: 0,
      tryItOutEnabled: true,
    },
    theme: {
      title: options.title,
      js: [{ filename: 'farmx-docs.js', content: DOCS_UI_SCRIPT }],
      css: [{ filename: 'farmx-docs.css', content: DOCS_UI_CSS }],
    },
  });

  // `/api-docs` → `/api-docs/`: with the trailing slash Swagger UI uses relative asset URLs.
  // (swagger-ui declares `/api-docs` itself, so this runs as a hook in the same scope.)
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.split('?')[0] === routePrefix) await reply.redirect(`${routePrefix}/`);
  });

  // Postman: Import → Link → <gateway>/api-docs.json
  app.get(`${routePrefix}.json`, { schema: { hide: true }, logLevel: 'silent' }, () => refresh());
};
