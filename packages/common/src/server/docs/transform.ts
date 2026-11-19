import Joi from 'joi';
import joiToSwaggerModule from 'joi-to-swagger';

import {
  type DocHeader,
  ENVELOPE_KEY,
  HEADERS_KEY,
  REQUEST_EXAMPLE_KEY,
  headersToJsonSchema,
} from './route-docs.js';

// CJS package: its types declare `export default`, so under NodeNext the function is on
// `.default` (also true at runtime: module.exports.default === module.exports).
const joiToSwagger = joiToSwaggerModule.default;

type JsonObject = Record<string, unknown>;

/** Named schemas (`Joi...meta({ className })`) collected while the spec is generated. */
export type ComponentRegistry = Map<string, unknown>;

const REQUEST_PARTS = ['body', 'querystring', 'params', 'headers'] as const;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Joi → JSON Schema; named sub-schemas become `$ref`s and are added to the registry. */
const toJsonSchema = (schema: unknown, registry: ComponentRegistry): unknown => {
  if (!Joi.isSchema(schema)) return schema;
  const { swagger, components } = joiToSwagger(schema);
  for (const [name, value] of Object.entries(components?.schemas ?? {})) registry.set(name, value);
  return swagger;
};

/** `{ success: true, data, meta? }` envelope around the converted `data` schema. */
const envelope = (spec: JsonObject, registry: ComponentRegistry): JsonObject => {
  const data = spec.data === undefined ? {} : toJsonSchema(spec.data, registry);
  const paginated = spec.paginated === true;
  return {
    description: spec.description,
    type: 'object',
    required: paginated ? ['success', 'data', 'meta'] : ['success', 'data'],
    properties: {
      success: { type: 'boolean', enum: [true] },
      data: paginated ? { type: 'array', items: data } : data,
      ...(paginated ? { meta: { $ref: '#/components/schemas/PaginationMeta' } } : {}),
    },
    ...(spec.example === undefined ? {} : { example: spec.example }),
    ...(spec.headers === undefined ? {} : { headers: spec.headers }),
  };
};

/** Merges doc-only request headers into the (converted) `headers` JSON schema. */
const withDocHeaders = (current: unknown, headers: Record<string, DocHeader>): JsonObject => {
  const extra = headersToJsonSchema(headers);
  if (!isObject(current)) return extra;
  const properties = isObject(current.properties) ? current.properties : {};
  const required = Array.isArray(current.required) ? (current.required as string[]) : [];
  return {
    ...current,
    type: 'object',
    properties: { ...properties, ...extra.properties },
    required: [...new Set([...required, ...extra.required])],
  };
};

/** Per-route transform for @fastify/swagger: Joi request/response schemas → OpenAPI. */
export const createDocsTransform =
  (registry: ComponentRegistry) =>
  ({ schema, url: rawUrl }: { schema: JsonObject | undefined; url: string }) => {
    // `/` routes under a prefix are registered as `/admin/users/`; document them without the slash.
    const url = rawUrl.length > 1 ? rawUrl.replace(/\/$/, '') : rawUrl;
    if (schema === undefined) return { schema, url };

    const converted: JsonObject = { ...schema };
    for (const part of REQUEST_PARTS) {
      if (part in schema) converted[part] = toJsonSchema(schema[part], registry);
    }

    const docHeaders = schema[HEADERS_KEY];
    if (isObject(docHeaders)) {
      converted.headers = withDocHeaders(
        converted.headers,
        docHeaders as Record<string, DocHeader>,
      );
    }
    Reflect.deleteProperty(converted, HEADERS_KEY);

    const requestExample = schema[REQUEST_EXAMPLE_KEY];
    if (requestExample !== undefined && isObject(converted.body)) {
      converted.body = { ...converted.body, example: requestExample };
    }
    Reflect.deleteProperty(converted, REQUEST_EXAMPLE_KEY);

    if (isObject(schema.response)) {
      converted.response = Object.fromEntries(
        Object.entries(schema.response).map(([status, value]) => [
          status,
          isObject(value) && value[ENVELOPE_KEY] === true
            ? envelope(value, registry)
            : toJsonSchema(value, registry),
        ]),
      );
    }

    return { schema: converted, url };
  };
