import { ok, paginated } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import Joi from 'joi';

import { admin, adminWrite, customerRead, expert } from '../../middleware/guards.js';
import { DATE, ID, PAGE, REASON, idParams, ifMatchOf } from '../../middleware/http.js';
import { actorOf } from '../audit/index.js';
import { CHANNELS } from '../options/index.js';
import { EXPERT_DOCS as D } from './experts.docs.js';
import {
  type AvailabilityInput,
  type CreateExpertInput,
  EXPERT_TYPES,
  type ExpertListQuery,
  type HolidayInput,
  PRODUCTION_TYPES,
  type RecommendQuery,
  type TimeOffInput,
  type UpdateExpertInput,
  type UpdateMyProfileInput,
} from './experts.types.js';

// ── schemas ──

const NAME = Joi.string().trim().min(2).max(120);
const TEXT = Joi.string().trim().min(1).max(120).allow(null);
const URL = Joi.string().uri({ scheme: ['https', 'http'] }).max(500).allow(null);
const LANGS = Joi.array().items(Joi.string().pattern(/^[a-z]{2,3}$/)).min(1).max(10).unique();
const IDS_LIST = Joi.array().items(ID).max(50).unique();
const TERRITORY = Joi.string().pattern(/^[A-Z0-9]{1,3}$/);
const CHANNEL_LIST = Joi.array()
  .items(Joi.string().valid(...CHANNELS))
  .max(CHANNELS.length)
  .unique();
const MINUTE = Joi.number().integer().min(0).max(1440);

const profileFields = {
  type: Joi.string().valid(...EXPERT_TYPES),
  displayName: NAME,
  title: TEXT,
  qualification: TEXT,
  photoUrl: URL,
  experienceYears: Joi.number().integer().min(0).max(60).allow(null),
  languages: LANGS,
  brandIds: IDS_LIST,
  categoryIds: IDS_LIST,
  productionTypes: Joi.array()
    .items(Joi.string().valid(...PRODUCTION_TYPES))
    .unique(),
  territoryCodes: Joi.array().items(TERRITORY).max(50).unique(),
  channels: CHANNEL_LIST,
  maxPerDay: Joi.number().integer().min(1).max(48),
  priority: Joi.number().integer().min(0).max(10),
  isBookable: Joi.boolean(),
};

const createBody = Joi.object<CreateExpertInput>({
  ...profileFields,
  userId: ID.required(),
  type: profileFields.type.required(),
  displayName: NAME.required(),
  languages: LANGS.required(),
  channels: CHANNEL_LIST.required(),
});

const updateBody = Joi.object<UpdateExpertInput>({ ...profileFields, isActive: Joi.boolean(), reason: REASON }).min(1);

const updateMeBody = Joi.object<UpdateMyProfileInput>({
  title: TEXT,
  photoUrl: URL,
  languages: LANGS,
}).min(1);

const availabilityBody = Joi.object<AvailabilityInput>({
  rules: Joi.array()
    .items(
      Joi.object({
        weekday: Joi.number().integer().min(0).max(6).required(),
        startMinute: MINUTE.required(),
        endMinute: MINUTE.greater(Joi.ref('startMinute')).required(),
        channels: CHANNEL_LIST,
        validFrom: DATE.allow(null),
        validTo: DATE.allow(null),
      }),
    )
    .max(50)
    .required(),
  breaks: Joi.array()
    .items(
      Joi.object({
        weekday: Joi.number().integer().min(0).max(6).allow(null),
        startMinute: MINUTE.required(),
        endMinute: MINUTE.greater(Joi.ref('startMinute')).required(),
      }),
    )
    .max(20)
    .default([]),
});

const ISO = Joi.string().isoDate();
const timeOffBody = Joi.object<TimeOffInput>({
  startAt: ISO.required(),
  endAt: ISO.required(),
  reason: Joi.string().trim().max(200).allow(null),
});

const holidayBody = Joi.object<HolidayInput>({
  date: DATE.required(),
  territoryCode: TERRITORY.allow(null),
  name: Joi.string().trim().min(2).max(120).required(),
});

const listQuery = Joi.object<ExpertListQuery>({
  ...PAGE,
  type: Joi.string().valid(...EXPERT_TYPES),
  isActive: Joi.boolean(),
  isBookable: Joi.boolean(),
  brandId: ID,
  categoryId: ID,
  q: Joi.string().trim().min(1).max(60),
});

const holidayQuery = Joi.object({ from: DATE.required(), to: DATE.required() });

const recommendQuery = Joi.object<RecommendQuery>({
  productId: ID.required(),
  farmId: ID,
  language: Joi.string().pattern(/^[a-z]{2,3}$/),
  limit: Joi.number().integer().min(1).max(3).default(1),
});

const timeOffParams = { params: Joi.object({ id: ID.required(), timeOffId: ID.required() }) };
const myTimeOffParams = { params: Joi.object({ timeOffId: ID.required() }) };

interface IdParams {
  id: string;
}
const svc = (req: FastifyRequest) => req.diScope.resolve('expertsService');
/** Set by the `expert` guard. */
const me = (req: FastifyRequest): string => {
  if (req.expertId === undefined) throw new Error('route is missing the expert guard');
  return req.expertId;
};

/** Mounted at `/calls` (gateway `/v1/calls`): admin, expert self-service and the customer card. */
export const expertsRoutes: FastifyPluginAsync = async (app) => {
  // ── admin: experts ──
  app.get<{ Querystring: ExpertListQuery }>(
    '/admin/experts',
    { schema: { querystring: listQuery, ...routeDocs(D.list) }, preHandler: admin('sales.view') },
    async (req) => paginated(await svc(req).list(req.query)),
  );
  app.post<{ Body: CreateExpertInput }>(
    '/admin/experts',
    { schema: { body: createBody, ...routeDocs(D.create) }, preHandler: adminWrite('sales.configure') },
    async (req, reply) => reply.status(201).send(ok(await svc(req).create(actorOf(req), req.body))),
  );
  app.get<{ Params: IdParams }>(
    '/admin/experts/:id',
    { schema: { ...idParams, ...routeDocs(D.get) }, preHandler: admin('sales.view') },
    async (req) => ok(await svc(req).get(req.params.id)),
  );
  app.patch<{ Params: IdParams; Body: UpdateExpertInput }>(
    '/admin/experts/:id',
    { schema: { ...idParams, body: updateBody, ...routeDocs(D.update) }, preHandler: adminWrite('sales.configure') },
    async (req) => ok(await svc(req).update(actorOf(req), req.params.id, req.body, ifMatchOf(req))),
  );
  app.get<{ Params: IdParams }>(
    '/admin/experts/:id/availability',
    { schema: { ...idParams, ...routeDocs(D.getAvailability) }, preHandler: admin('sales.view') },
    async (req) => ok(await svc(req).availability(req.params.id)),
  );
  app.put<{ Params: IdParams; Body: AvailabilityInput }>(
    '/admin/experts/:id/availability',
    {
      schema: { ...idParams, body: availabilityBody, ...routeDocs(D.putAvailability) },
      preHandler: adminWrite('sales.configure'),
    },
    async (req) => ok(await svc(req).putAvailability(actorOf(req), req.params.id, req.body)),
  );
  app.get<{ Params: IdParams }>(
    '/admin/experts/:id/time-off',
    { schema: { ...idParams, ...routeDocs(D.listTimeOff) }, preHandler: admin('sales.view') },
    async (req) => ok(await svc(req).timeOffs(req.params.id)),
  );
  app.post<{ Params: IdParams; Body: TimeOffInput }>(
    '/admin/experts/:id/time-off',
    {
      schema: { ...idParams, body: timeOffBody, ...routeDocs(D.addTimeOff) },
      preHandler: adminWrite('sales.configure'),
    },
    async (req, reply) =>
      reply.status(201).send(ok(await svc(req).addTimeOff(actorOf(req), req.params.id, req.body))),
  );
  app.delete<{ Params: IdParams & { timeOffId: string } }>(
    '/admin/experts/:id/time-off/:timeOffId',
    { schema: { ...timeOffParams, ...routeDocs(D.removeTimeOff) }, preHandler: adminWrite('sales.configure') },
    async (req, reply) => {
      await svc(req).removeTimeOff(actorOf(req), req.params.id, req.params.timeOffId);
      return reply.status(204).send();
    },
  );

  // ── admin: holidays ──
  app.get<{ Querystring: { from: string; to: string } }>(
    '/admin/holidays',
    { schema: { querystring: holidayQuery, ...routeDocs(D.listHolidays) }, preHandler: admin('sales.view') },
    async (req) => ok(await svc(req).holidays(req.query.from, req.query.to)),
  );
  app.post<{ Body: HolidayInput }>(
    '/admin/holidays',
    { schema: { body: holidayBody, ...routeDocs(D.addHoliday) }, preHandler: adminWrite('sales.configure') },
    async (req, reply) => reply.status(201).send(ok(await svc(req).addHoliday(actorOf(req), req.body))),
  );
  app.delete<{ Params: IdParams }>(
    '/admin/holidays/:id',
    { schema: { ...idParams, ...routeDocs(D.removeHoliday) }, preHandler: adminWrite('sales.configure') },
    async (req, reply) => {
      await svc(req).removeHoliday(actorOf(req), req.params.id);
      return reply.status(204).send();
    },
  );

  // ── expert: self ──
  app.get('/experts/me', { schema: { ...routeDocs(D.me) }, preHandler: expert }, async (req) =>
    ok(await svc(req).me(me(req))),
  );
  app.patch<{ Body: UpdateMyProfileInput }>(
    '/experts/me',
    { schema: { body: updateMeBody, ...routeDocs(D.updateMe) }, preHandler: expert },
    async (req) => ok(await svc(req).updateMe(actorOf(req), me(req), req.body)),
  );
  app.put('/experts/me/presence', { schema: { ...routeDocs(D.heartbeat) }, preHandler: expert }, async (req) =>
    ok(await svc(req).heartbeat(me(req))),
  );
  app.delete(
    '/experts/me/presence',
    { schema: { ...routeDocs(D.offline) }, preHandler: expert },
    async (req, reply) => {
      await svc(req).goOffline(me(req));
      return reply.status(204).send();
    },
  );
  app.get(
    '/experts/me/availability',
    { schema: { ...routeDocs(D.myAvailability) }, preHandler: expert },
    async (req) => ok(await svc(req).availability(me(req))),
  );
  app.put<{ Body: AvailabilityInput }>(
    '/experts/me/availability',
    { schema: { body: availabilityBody, ...routeDocs(D.putMyAvailability) }, preHandler: expert },
    async (req) => ok(await svc(req).putAvailability(actorOf(req), me(req), req.body)),
  );
  app.get('/experts/me/time-off', { schema: { ...routeDocs(D.myTimeOff) }, preHandler: expert }, async (req) =>
    ok(await svc(req).timeOffs(me(req))),
  );
  app.post<{ Body: TimeOffInput }>(
    '/experts/me/time-off',
    { schema: { body: timeOffBody, ...routeDocs(D.addMyTimeOff) }, preHandler: expert },
    async (req, reply) => reply.status(201).send(ok(await svc(req).addTimeOff(actorOf(req), me(req), req.body))),
  );
  app.delete<{ Params: { timeOffId: string } }>(
    '/experts/me/time-off/:timeOffId',
    { schema: { ...myTimeOffParams, ...routeDocs(D.removeMyTimeOff) }, preHandler: expert },
    async (req, reply) => {
      await svc(req).removeTimeOff(actorOf(req), me(req), req.params.timeOffId);
      return reply.status(204).send();
    },
  );

  // ── customer ──
  app.get<{ Querystring: RecommendQuery }>(
    '/experts/recommended',
    { schema: { querystring: recommendQuery, ...routeDocs(D.recommended) }, preHandler: customerRead },
    async (req) => {
      if (req.user === null) throw new Error('route is missing the customer guard');
      return ok(await svc(req).recommended(req.user.id, req.query));
    },
  );
};
