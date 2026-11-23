import Joi from 'joi';

import { ID, PAGE } from '../../middleware/http.js';
import { FULFILMENT_STATUSES } from './orders.rules.js';

export const listOrdersSchema = {
  params: Joi.object({ id: ID.required() }),
  querystring: Joi.object({
    status: Joi.string()
      .valid('OPEN', ...FULFILMENT_STATUSES)
      .default('OPEN')
      .description('OPEN = NEW + ALLOCATED (the Active Orders tab)'),
    ...PAGE,
  }),
};
