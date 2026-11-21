import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import Joi from 'joi';

import { admin, adminWrite } from '../../middleware/guards.js';
import { REASON, idParams } from '../../middleware/http.js';
import { actorOf } from '../audit/index.js';
import { OPTION_DOCS } from './options.docs.js';
import { SETTING_KEYS, type SettingKey } from './options.settings.js';
import {
  type CreateOptionInput,
  OPTION_TYPES,
  type OptionType,
  type UpdateOptionInput,
  type UpdateSettingInput,
} from './options.types.js';

const SCORED = ['INTENT', 'TIMEFRAME'];
const LABEL = Joi.string().trim().min(1).max(80);
const ICON = Joi.string().trim().pattern(/^[a-z0-9-]{1,40}$/).allow(null);
const SORT = Joi.number().integer().min(0).max(999);
const META = Joi.object().unknown(true).max(20).allow(null);

const createBody = Joi.object<CreateOptionInput>({
  type: Joi.string()
    .valid(...OPTION_TYPES)
    .required(),
  code: Joi.when('type', {
    is: 'LANGUAGE',
    then: Joi.string()
      .pattern(/^[a-z]{2,3}$/)
      .required()
      .messages({ 'string.pattern.base': 'LANGUAGE code must be an ISO 639-1/2 code (e.g. en, hi)' }),
    otherwise: Joi.string()
      .pattern(/^[A-Z][A-Z0-9_]{1,39}$/)
      .required()
      .messages({ 'string.pattern.base': 'code must be UPPER_SNAKE_CASE (2–40 chars)' }),
  }),
  label: LABEL.required(),
  icon: ICON,
  sortOrder: SORT,
  meta: Joi.when('type', {
    is: Joi.valid(...SCORED),
    then: Joi.object({ scoreWeight: Joi.number().integer().min(0).max(100).required() })
      .unknown(true)
      .required(),
    otherwise: META,
  }),
});

const updateBody = Joi.object<UpdateOptionInput>({
  label: LABEL,
  icon: ICON,
  sortOrder: SORT,
  isActive: Joi.boolean(),
  meta: META,
  reason: REASON,
})
  .min(1)
  .when(Joi.object({ isActive: Joi.valid(false) }).unknown(), {
    then: Joi.object({ reason: REASON.required() }),
  });

const settingParams = {
  params: Joi.object({
    key: Joi.string()
      .valid(...SETTING_KEYS)
      .required(),
  }),
};
const settingBody = Joi.object<UpdateSettingInput>({
  value: Joi.any().required().description('Shape depends on the key (see the setting list)'),
  reason: REASON.required(),
});

const svc = (req: FastifyRequest) => req.diScope.resolve('optionsService');

/** Mounted at `/calls/admin` (gateway: `/v1/calls/admin`). Staff only. */
export const optionsAdminRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { type?: OptionType } }>(
    '/options',
    {
      schema: {
        querystring: Joi.object({ type: Joi.string().valid(...OPTION_TYPES) }),
        ...routeDocs(OPTION_DOCS.list),
      },
      preHandler: admin('sales.view'),
    },
    async (req) => ok(await svc(req).list(req.query.type)),
  );
  app.post<{ Body: CreateOptionInput }>(
    '/options',
    {
      schema: { body: createBody, ...routeDocs(OPTION_DOCS.create) },
      preHandler: adminWrite('sales.configure'),
    },
    async (req, reply) => {
      const created = await svc(req).create(actorOf(req), req.body);
      return reply.status(201).send(ok(created));
    },
  );
  app.patch<{ Params: { id: string }; Body: UpdateOptionInput }>(
    '/options/:id',
    {
      schema: { ...idParams, body: updateBody, ...routeDocs(OPTION_DOCS.update) },
      preHandler: adminWrite('sales.configure'),
    },
    async (req) => ok(await svc(req).update(actorOf(req), req.params.id, req.body)),
  );
  app.get(
    '/settings',
    { schema: { ...routeDocs(OPTION_DOCS.listSettings) }, preHandler: admin('sales.view') },
    async (req) => ok(await svc(req).listSettings()),
  );
  app.put<{ Params: { key: SettingKey }; Body: UpdateSettingInput }>(
    '/settings/:key',
    {
      schema: { ...settingParams, body: settingBody, ...routeDocs(OPTION_DOCS.updateSetting) },
      preHandler: adminWrite('sales.configure'),
    },
    async (req) => ok(await svc(req).updateSetting(actorOf(req), req.params.key, req.body)),
  );
};
