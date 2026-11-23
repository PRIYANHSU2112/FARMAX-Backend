import { ValidationError } from '@farmx/common/errors';
import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import Joi from 'joi';
import { IANAZone } from 'luxon';

import { admin, adminWrite } from '../../middleware/guards.js';
import { DATE, ID, REASON, idParams } from '../../middleware/http.js';
import { actorOf } from '../audit/index.js';
import { SETTINGS_DOCS } from './settings.docs.js';
import {
  type CalendarInput,
  SETTING_KEYS,
  SETTING_SCHEMAS,
  type SettingKey,
} from './settings.types.js';

const ZONE = Joi.string()
  .max(40)
  .custom((value: string, helpers) =>
    IANAZone.isValidZone(value) ? value : helpers.error('any.invalid'),
  )
  .messages({ 'any.invalid': 'must be an IANA time zone, e.g. Asia/Kolkata' });

const WINDOWS = Joi.array()
  .items(
    Joi.object({
      weekday: Joi.number().integer().min(0).max(6).required(),
      startMinute: Joi.number().integer().min(0).max(1439).required(),
      endMinute: Joi.number().integer().min(1).max(1440).greater(Joi.ref('startMinute')).required(),
    }),
  )
  .max(28);

const calendarCreate = Joi.object<CalendarInput>({
  name: Joi.string().trim().min(2).max(80).required(),
  timezone: ZONE.required(),
  weeklyHours: WINDOWS.min(1).required(),
  isActive: Joi.boolean(),
  reason: REASON,
});
const calendarUpdate = Joi.object<Partial<CalendarInput>>({
  name: Joi.string().trim().min(2).max(80),
  timezone: ZONE,
  weeklyHours: WINDOWS.min(1),
  isActive: Joi.boolean(),
  reason: REASON.required(),
}).min(2);

const svc = (req: FastifyRequest) => req.diScope.resolve('settingsService');

/** Mounted at `/support/admin` (gateway: `/v1/support/admin`). Staff only. */
export const settingsAdminRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/settings',
    { schema: routeDocs(SETTINGS_DOCS.list), preHandler: admin('support.view') },
    async (req) => ok(await svc(req).listSettings()),
  );
  app.put<{ Params: { key: SettingKey }; Body: { value: object; reason: string } }>(
    '/settings/:key',
    {
      schema: {
        params: Joi.object({
          key: Joi.string()
            .valid(...SETTING_KEYS)
            .required(),
        }),
        body: Joi.object({ value: Joi.object().required(), reason: REASON.required() }),
        ...routeDocs(SETTINGS_DOCS.update),
      },
      preHandler: adminWrite('support.configure'),
    },
    async (req) => {
      const { error, value } = SETTING_SCHEMAS[req.params.key].validate(req.body.value, {
        abortEarly: false,
      }) as {
        error?: Joi.ValidationError;
        value: object;
      };
      if (error !== undefined)
        throw new ValidationError(
          error.details.map((d) => ({ path: `value.${d.path.join('.')}`, message: d.message })),
        );
      return ok(await svc(req).updateSetting(actorOf(req), req.params.key, value, req.body.reason));
    },
  );
  app.get(
    '/calendars',
    { schema: routeDocs(SETTINGS_DOCS.listCalendars), preHandler: admin('support.view') },
    async (req) => ok(await svc(req).listCalendars()),
  );
  app.post<{ Body: CalendarInput }>(
    '/calendars',
    {
      schema: { body: calendarCreate, ...routeDocs(SETTINGS_DOCS.createCalendar) },
      preHandler: adminWrite('support.configure'),
    },
    async (req, reply) =>
      reply.status(201).send(ok(await svc(req).createCalendar(actorOf(req), req.body))),
  );
  app.patch<{ Params: { id: string }; Body: Partial<CalendarInput> }>(
    '/calendars/:id',
    {
      schema: { ...idParams, body: calendarUpdate, ...routeDocs(SETTINGS_DOCS.updateCalendar) },
      preHandler: adminWrite('support.configure'),
    },
    async (req) => ok(await svc(req).updateCalendar(actorOf(req), req.params.id, req.body)),
  );
  app.post<{ Params: { id: string }; Body: { date: string; name: string } }>(
    '/calendars/:id/holidays',
    {
      schema: {
        ...idParams,
        body: Joi.object({
          date: DATE.required(),
          name: Joi.string().trim().min(2).max(80).required(),
        }),
        ...routeDocs(SETTINGS_DOCS.addHoliday),
      },
      preHandler: adminWrite('support.configure'),
    },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          ok(await svc(req).addHoliday(actorOf(req), req.params.id, req.body.date, req.body.name)),
        ),
  );
  app.delete<{ Params: { id: string; holidayId: string }; Body: { reason: string } }>(
    '/calendars/:id/holidays/:holidayId',
    {
      schema: {
        params: Joi.object({ id: ID.required(), holidayId: ID.required() }),
        body: Joi.object({ reason: REASON.required() }),
        ...routeDocs(SETTINGS_DOCS.deleteHoliday),
      },
      preHandler: adminWrite('support.configure'),
    },
    async (req, reply) => {
      await svc(req).deleteHoliday(
        actorOf(req),
        req.params.id,
        req.params.holidayId,
        req.body.reason,
      );
      return reply.status(204).send();
    },
  );
};
