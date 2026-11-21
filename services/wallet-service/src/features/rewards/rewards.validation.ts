import Joi from 'joi';

import { PAGE } from '../../middleware/http.js';

export const ledgerSchema = { querystring: Joi.object({ ...PAGE }) };

export const convertSchema = {
  body: Joi.object({
    /** Whole points; minimum and step come from wallet settings (422 BELOW_MINIMUM / NOT_A_MULTIPLE). */
    points: Joi.number().integer().min(1).max(100_000_000).required(),
  }),
};
