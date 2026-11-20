import Joi from 'joi';

import { CONFIGURABLE_CATEGORIES } from './preferences.policy.js';

export const updatePreferencesSchema = {
  body: Joi.object({
    changes: Joi.array()
      .items(
        Joi.object({
          category: Joi.string()
            .valid(...CONFIGURABLE_CATEGORIES)
            .required()
            .description('SECURITY cannot be changed (always delivered)'),
          channel: Joi.string().valid('PUSH', 'EMAIL', 'SMS').required(),
          enabled: Joi.boolean().required(),
        }),
      )
      .min(1)
      .max(CONFIGURABLE_CATEGORIES.length * 3)
      .unique(
        (a: { category: string; channel: string }, b: { category: string; channel: string }) =>
          a.category === b.category && a.channel === b.channel,
      )
      .required(),
  }),
};
