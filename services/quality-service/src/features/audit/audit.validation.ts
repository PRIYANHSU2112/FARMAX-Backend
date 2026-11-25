import Joi from 'joi';

import { ID, PAGE } from '../../middleware/http.js';

export const auditQuery = {
  querystring: Joi.object({
    targetType: Joi.string().valid('sample', 'coa', 'batch', 'decision', 'spec', 'lab'),
    targetId: ID,
    actorUserId: ID,
    ...PAGE,
    cursor: ID,
  }),
};
