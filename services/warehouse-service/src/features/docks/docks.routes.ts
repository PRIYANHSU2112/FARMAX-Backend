import { ok } from '@farmx/common/response';
import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { callerOf, staffRead, staffWrite } from '../../middleware/guards.js';
import { DOCK_DOCS as D } from './docks.docs.js';
import type {
  BookingInput,
  DoorInput,
  DoorUpdate,
  StagingInput,
  YardSlotInput,
} from './docks.types.js';
import * as V from './docks.validation.js';

interface W {
  id: string;
}
const svc = (req: FastifyRequest) => req.diScope.resolve('docksService');
const read = staffRead('warehouse.view');
const conf = staffWrite('warehouse.configure');
const op = staffWrite('warehouse.operate');

/** Mounted at `/admin/warehouses` (gateway `/v1/admin/warehouses`): W2.07 dock & yard. */
export const docksRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: W }>(
    '/:id/dock-yard',
    { schema: { ...V.warehouseOnly, ...routeDocs(D.summary) }, preHandler: read },
    async (req) => ok(await svc(req).summary(callerOf(req), req.params.id)),
  );

  // Doors
  app.get<{ Params: W }>(
    '/:id/dock-doors',
    { schema: { ...V.warehouseOnly, ...routeDocs(D.doors) }, preHandler: read },
    async (req) => ok(await svc(req).doors(callerOf(req), req.params.id)),
  );
  app.post<{ Params: W; Body: DoorInput }>(
    '/:id/dock-doors',
    { schema: { ...V.createDoorSchema, ...routeDocs(D.createDoor) }, preHandler: conf },
    async (req, reply) =>
      reply.code(201).send(ok(await svc(req).createDoor(callerOf(req), req.params.id, req.body))),
  );
  app.patch<{ Params: W & { doorId: string }; Body: DoorUpdate }>(
    '/:id/dock-doors/:doorId',
    { schema: { ...V.updateDoorSchema, ...routeDocs(D.updateDoor) }, preHandler: conf },
    async (req) =>
      ok(await svc(req).updateDoor(callerOf(req), req.params.id, req.params.doorId, req.body)),
  );
  app.delete<{ Params: W & { doorId: string } }>(
    '/:id/dock-doors/:doorId',
    { schema: { ...V.doorParams, ...routeDocs(D.deleteDoor) }, preHandler: conf },
    async (req, reply) => {
      await svc(req).deleteDoor(callerOf(req), req.params.id, req.params.doorId);
      return reply.code(204).send();
    },
  );

  // Bookings
  app.get<{ Params: W; Querystring: { date?: string } }>(
    '/:id/dock-bookings',
    { schema: { ...V.bookingsSchema, ...routeDocs(D.bookings) }, preHandler: read },
    async (req) => ok(await svc(req).bookings(callerOf(req), req.params.id, req.query.date)),
  );
  app.post<{ Params: W & { doorId: string }; Body: BookingInput }>(
    '/:id/dock-doors/:doorId/bookings',
    { schema: { ...V.bookSchema, ...routeDocs(D.book) }, preHandler: op },
    async (req, reply) =>
      reply
        .code(201)
        .send(ok(await svc(req).book(callerOf(req), req.params.id, req.params.doorId, req.body))),
  );
  for (const action of ['start', 'complete', 'cancel'] as const) {
    app.post<{ Params: W & { bookingId: string } }>(
      `/:id/dock-bookings/:bookingId/${action}`,
      { schema: { ...V.bookingParams, ...routeDocs(D[action]) }, preHandler: op },
      async (req) =>
        ok(await svc(req).moveBooking(callerOf(req), req.params.id, req.params.bookingId, action)),
    );
  }

  // Staging areas
  app.get<{ Params: W }>(
    '/:id/staging-areas',
    { schema: { ...V.warehouseOnly, ...routeDocs(D.staging) }, preHandler: read },
    async (req) => ok(await svc(req).staging(callerOf(req), req.params.id)),
  );
  app.post<{ Params: W; Body: StagingInput }>(
    '/:id/staging-areas',
    { schema: { ...V.createStagingSchema, ...routeDocs(D.createStaging) }, preHandler: conf },
    async (req, reply) =>
      reply
        .code(201)
        .send(ok(await svc(req).createStaging(callerOf(req), req.params.id, req.body))),
  );
  app.patch<{ Params: W & { stagingId: string }; Body: Partial<StagingInput> }>(
    '/:id/staging-areas/:stagingId',
    { schema: { ...V.updateStagingSchema, ...routeDocs(D.updateStaging) }, preHandler: conf },
    async (req) =>
      ok(
        await svc(req).updateStaging(callerOf(req), req.params.id, req.params.stagingId, req.body),
      ),
  );
  app.delete<{ Params: W & { stagingId: string } }>(
    '/:id/staging-areas/:stagingId',
    { schema: { ...V.stagingParams, ...routeDocs(D.deleteStaging) }, preHandler: conf },
    async (req, reply) => {
      await svc(req).deleteStaging(callerOf(req), req.params.id, req.params.stagingId);
      return reply.code(204).send();
    },
  );

  // Yard slots
  app.get<{ Params: W }>(
    '/:id/yard-slots',
    { schema: { ...V.warehouseOnly, ...routeDocs(D.slots) }, preHandler: read },
    async (req) => ok(await svc(req).slots(callerOf(req), req.params.id)),
  );
  app.post<{ Params: W; Body: YardSlotInput }>(
    '/:id/yard-slots',
    { schema: { ...V.createSlotSchema, ...routeDocs(D.createSlot) }, preHandler: conf },
    async (req, reply) =>
      reply.code(201).send(ok(await svc(req).createSlot(callerOf(req), req.params.id, req.body))),
  );
  app.patch<{ Params: W & { slotId: string }; Body: Partial<Omit<YardSlotInput, 'code'>> }>(
    '/:id/yard-slots/:slotId',
    { schema: { ...V.updateSlotSchema, ...routeDocs(D.updateSlot) }, preHandler: conf },
    async (req) =>
      ok(await svc(req).updateSlot(callerOf(req), req.params.id, req.params.slotId, req.body)),
  );
  app.delete<{ Params: W & { slotId: string } }>(
    '/:id/yard-slots/:slotId',
    { schema: { ...V.slotParams, ...routeDocs(D.deleteSlot) }, preHandler: conf },
    async (req, reply) => {
      await svc(req).deleteSlot(callerOf(req), req.params.id, req.params.slotId);
      return reply.code(204).send();
    },
  );
  app.post<{ Params: W & { slotId: string }; Body: { vehicleNo: string } }>(
    '/:id/yard-slots/:slotId/occupy',
    { schema: { ...V.occupySchema, ...routeDocs(D.occupy) }, preHandler: op },
    async (req) =>
      ok(
        await svc(req).occupy(callerOf(req), req.params.id, req.params.slotId, req.body.vehicleNo),
      ),
  );
  app.post<{ Params: W & { slotId: string } }>(
    '/:id/yard-slots/:slotId/release',
    { schema: { ...V.slotParams, ...routeDocs(D.release) }, preHandler: op },
    async (req) => ok(await svc(req).occupy(callerOf(req), req.params.id, req.params.slotId, null)),
  );
};
