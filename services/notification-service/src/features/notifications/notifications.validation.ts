import Joi from 'joi';

import { CATEGORIES } from '../../domain.js';
import { APP, ID, PAGE, idParams } from '../../middleware/http.js';

const appQuery = Joi.object({ app: APP });

export const listInboxSchema = {
  querystring: Joi.object({
    app: APP,
    unread: Joi.boolean().description('Only unread entries'),
    category: Joi.string().valid(...CATEGORIES),
    ...PAGE,
  }),
};

export const appOnlySchema = { querystring: appQuery };

export const inboxItemSchema = { ...idParams, querystring: appQuery };

export const readAllSchema = {
  body: Joi.object({
    app: APP,
    before: Joi.date()
      .iso()
      .description(
        'Only entries created up to this instant (use the newest `createdAt` the user saw, so entries arriving meanwhile stay unread). Default: now.',
      ),
  }).default({}),
};

export const streamSchema = { querystring: appQuery };

export { ID };
