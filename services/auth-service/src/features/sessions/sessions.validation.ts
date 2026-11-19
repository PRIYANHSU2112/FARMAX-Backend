import Joi from 'joi';

export const revokeOwnSessionSchema = {
  params: Joi.object({ id: Joi.string().guid().required().description('Session id') }),
};
