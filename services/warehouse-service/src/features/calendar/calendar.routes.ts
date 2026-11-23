import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { callerOf, staffRead, staffWrite } from '../../middleware/guards.js';
import { CALENDAR_DOCS as D } from './calendar.docs.js';
import type {
  CutoffType,
  DayHours,
  HolidayInput,
  ShiftInput,
  ShiftUpdate,
} from './calendar.types.js';
import * as V from './calendar.validation.js';

interface W {
  id: string;
}
const svc = (req: FastifyRequest) => req.diScope.resolve('calendarService');
const read = staffRead('warehouse.view');
const conf = staffWrite('warehouse.configure');

/** Mounted at `/admin/warehouses` (gateway `/v1/admin/warehouses`): W2.09 calendar & shifts. */
export const calendarRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: W }>(
    '/:id/calendar',
    { schema: { ...V.calendarSchema, ...routeDocs(D.get) }, preHandler: read },
    async (req) => ok(await svc(req).get(callerOf(req), req.params.id)),
  );
  app.put<{ Params: W; Body: { days: DayHours[] } }>(
    '/:id/operating-hours',
    { schema: { ...V.hoursSchema, ...routeDocs(D.hours) }, preHandler: conf },
    async (req) => ok(await svc(req).putHours(callerOf(req), req.params.id, req.body.days)),
  );
  app.put<{ Params: W; Body: { cutoffs: { type: CutoffType; cutoffTime: string | null }[] } }>(
    '/:id/cutoffs',
    { schema: { ...V.cutoffsSchema, ...routeDocs(D.cutoffs) }, preHandler: conf },
    async (req) => ok(await svc(req).putCutoffs(callerOf(req), req.params.id, req.body.cutoffs)),
  );

  app.post<{ Params: W; Body: ShiftInput }>(
    '/:id/shifts',
    { schema: { ...V.createShiftSchema, ...routeDocs(D.createShift) }, preHandler: conf },
    async (req, reply) =>
      reply.code(201).send(ok(await svc(req).createShift(callerOf(req), req.params.id, req.body))),
  );
  app.patch<{ Params: W & { shiftId: string }; Body: ShiftUpdate }>(
    '/:id/shifts/:shiftId',
    { schema: { ...V.updateShiftSchema, ...routeDocs(D.updateShift) }, preHandler: conf },
    async (req) =>
      ok(await svc(req).updateShift(callerOf(req), req.params.id, req.params.shiftId, req.body)),
  );
  app.delete<{ Params: W & { shiftId: string } }>(
    '/:id/shifts/:shiftId',
    { schema: { ...V.shiftParams, ...routeDocs(D.deleteShift) }, preHandler: conf },
    async (req, reply) => {
      await svc(req).deleteShift(callerOf(req), req.params.id, req.params.shiftId);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: W; Body: HolidayInput }>(
    '/:id/holidays',
    { schema: { ...V.createHolidaySchema, ...routeDocs(D.createHoliday) }, preHandler: conf },
    async (req, reply) =>
      reply
        .code(201)
        .send(ok(await svc(req).createHoliday(callerOf(req), req.params.id, req.body))),
  );
  app.patch<{ Params: W & { holidayId: string }; Body: Partial<HolidayInput> }>(
    '/:id/holidays/:holidayId',
    { schema: { ...V.updateHolidaySchema, ...routeDocs(D.updateHoliday) }, preHandler: conf },
    async (req) =>
      ok(
        await svc(req).updateHoliday(callerOf(req), req.params.id, req.params.holidayId, req.body),
      ),
  );
  app.delete<{ Params: W & { holidayId: string } }>(
    '/:id/holidays/:holidayId',
    { schema: { ...V.holidayParams, ...routeDocs(D.deleteHoliday) }, preHandler: conf },
    async (req, reply) => {
      await svc(req).deleteHoliday(callerOf(req), req.params.id, req.params.holidayId);
      return reply.code(204).send();
    },
  );
};
