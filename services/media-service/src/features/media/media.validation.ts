import Joi from 'joi';

import { MEDIA_KINDS } from './media.types.js';

/** POST /upload — the file itself is multipart (validated by content, not by Joi). */
export const uploadSchema = {
  querystring: Joi.object({
    type: Joi.string()
      .valid(...MEDIA_KINDS)
      .description('Optional: expected kind. 422 when the file is something else.')
      .meta({ className: 'MediaKind' }),
  }),
};
