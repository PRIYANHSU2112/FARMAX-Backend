import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

/** Swagger section for this feature. */
export const EXAMPLE_TAG = 'Examples';

/** Response schema (docs only), published as the reusable `Example` component. */
const exampleSchema = Joi.object({
  id: Joi.string().guid(),
  name: Joi.string().example('First'),
  ownerId: Joi.string().guid().allow(null),
  createdAt: Joi.date().iso(),
  updatedAt: Joi.date().iso(),
}).meta({ className: 'Example' });

const example = {
  id: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e01',
  name: 'First',
  ownerId: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e00',
  createdAt: '2026-11-11T06:00:00.000Z',
  updatedAt: '2026-11-11T06:00:00.000Z',
};

/** Swagger docs per route — spread into the route `schema` with `routeDocs()`. */
export const EXAMPLE_DOCS = {
  list: {
    tag: EXAMPLE_TAG,
    summary: 'List examples',
    success: {
      status: 200,
      description: 'A page of examples',
      data: exampleSchema,
      paginated: true,
      example: { success: true, data: [example], meta: { nextCursor: null, limit: 20 } },
    },
    errors: [422],
  },
  get: {
    tag: EXAMPLE_TAG,
    summary: 'Get an example',
    success: {
      status: 200,
      description: 'The example',
      data: exampleSchema,
      example: { success: true, data: example },
    },
    errors: [404, 422],
  },
  create: {
    tag: EXAMPLE_TAG,
    summary: 'Create an example',
    success: {
      status: 201,
      description: 'Created',
      data: exampleSchema,
      example: { success: true, data: example },
    },
    errors: [422],
  },
} satisfies Record<string, RouteDocs>;
