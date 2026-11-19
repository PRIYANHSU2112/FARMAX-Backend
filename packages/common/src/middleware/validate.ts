import { ValidationError } from '../errors/index.js';
import type { FastifySchemaCompiler } from 'fastify';
import type Joi from 'joi';

const BODY_OPTIONS: Joi.ValidationOptions = {
  abortEarly: false,
  stripUnknown: true,
  convert: true,
};

/** Headers always contain extra keys; never strip them. */
const HEADER_OPTIONS: Joi.ValidationOptions = {
  abortEarly: false,
  allowUnknown: true,
  stripUnknown: false,
  convert: true,
};

/**
 * Fastify validator compiler for Joi schemas on `body`, `querystring`, `params`, `headers`.
 * Returns a ValidationError (422) with every issue, e.g. `{ path: "body.email", message }`.
 */
export const joiValidatorCompiler: FastifySchemaCompiler<Joi.Schema> = ({ schema, httpPart }) => {
  const options = httpPart === 'headers' ? HEADER_OPTIONS : BODY_OPTIONS;
  const part = httpPart ?? 'body';

  return (data: unknown) => {
    const result = schema.validate(data, options);
    if (result.error) {
      return {
        error: new ValidationError(
          result.error.details.map((detail) => ({
            path: [part, ...detail.path].join('.'),
            message: detail.message,
          })),
        ),
      };
    }
    return { value: result.value as unknown };
  };
};

/**
 * Response schemas are Joi (used for OpenAPI docs only), so serialize with plain JSON
 * instead of fast-json-stringify.
 */
export const jsonSerializerCompiler = () => (data: unknown) => JSON.stringify(data);
