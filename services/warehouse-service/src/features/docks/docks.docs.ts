import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { IF_VERSION, staffDoc } from '../../docs/shared.js';

export const ADMIN_DOCKS_TAG = 'Admin Warehouse Dock & Yard';

const T = ADMIN_DOCKS_TAG;
const conf = 'warehouse.configure';
const op = 'warehouse.operate';
const view = 'warehouse.view';

const capacity = Joi.object({
  unit: Joi.string().valid('TONNES', 'PALLETS'),
  total: Joi.string().example('240.00'),
  planned: Joi.string(),
  used: Joi.string(),
  available: Joi.string(),
  usedPct: Joi.number(),
}).meta({ className: 'UnloadingCapacity' });

const door = Joi.object({
  id: Joi.string().guid(),
  code: Joi.string().example('D1'),
  name: Joi.string(),
  type: Joi.string().valid('UNLOADING', 'LOADING', 'BOTH'),
  vehicleClass: Joi.string(),
  capacityPerDay: Joi.string(),
  equipment: Joi.string().valid('STANDARD', 'HOPPER', 'CONVEYOR', 'SCALE', 'WEIGHBRIDGE'),
  capacityUnit: Joi.string(),
  opensAt: Joi.string().allow(null),
  closesAt: Joi.string().allow(null),
  status: Joi.string(),
  displayStatus: Joi.string().valid('AVAILABLE', 'BUSY', 'INACTIVE', 'MAINTENANCE'),
  currentUse: Joi.object({
    bookingId: Joi.string().guid(),
    refNo: Joi.string().example('INB-1045'),
    loadQty: Joi.string().example('8.00'),
    loadUnit: Joi.string(),
  }).allow(null),
  version: Joi.number().integer(),
}).meta({ className: 'DockDoor' });

const booking = Joi.object({
  id: Joi.string().guid(),
  dockDoorId: Joi.string().guid(),
  doorCode: Joi.string(),
  direction: Joi.string(),
  refNo: Joi.string(),
  loadQty: Joi.string(),
  loadUnit: Joi.string(),
  plannedStart: Joi.date().iso(),
  plannedEnd: Joi.date().iso(),
  status: Joi.string().valid('PLANNED', 'IN_USE', 'DONE', 'CANCELLED'),
  startedAt: Joi.date().iso().allow(null),
  endedAt: Joi.date().iso().allow(null),
}).meta({ className: 'DockBooking' });

export const DOCK_DOCS = {
  summary: staffDoc(T, 'Dock & yard KPIs (W2.07)', view, {
    description:
      "Doors (active / busy / inactive), staging pallets, yard slots and today's unloading capacity PER UNIT (tonnes and pallets are separate entries, never added).",
    data: Joi.object({
      date: Joi.string(),
      doors: Joi.object(),
      staging: Joi.object(),
      yard: Joi.object(),
      unloadingCapacity: Joi.array().items(capacity),
    }).meta({ className: 'DockYardSummary' }),
  }),
  doors: staffDoc(T, 'Dock doors', view, { data: Joi.array().items(door) }),
  createDoor: staffDoc(T, 'Add dock door', conf, {
    status: 201,
    data: door,
    errors: [404, 409, 422],
  }),
  updateDoor: staffDoc(T, 'Edit dock door', conf, {
    data: door,
    errors: [404, 409, 422],
    description: `409 DOOR_HAS_BOOKINGS when changing the unit with open bookings. ${IF_VERSION}`,
  }),
  deleteDoor: staffDoc(T, 'Delete dock door', conf, {
    status: 204,
    errors: [404, 409, 422],
    description: 'A door with booking history is set INACTIVE instead (409 DOOR_HAS_BOOKINGS).',
  }),
  bookings: staffDoc(T, 'Dock bookings of a day', view, { data: Joi.array().items(booking) }),
  book: staffDoc(T, 'Book a dock door (mark busy)', op, {
    status: 201,
    data: booking,
    errors: [404, 409, 422],
    description:
      'Manual until Gate (W5) creates bookings. `loadQty` is in the door unit. Overlapping open bookings → 409 DOCK_BUSY (also enforced by the database).',
  }),
  start: staffDoc(T, 'Start a booking (door busy)', op, { data: booking, errors: [404, 409, 422] }),
  complete: staffDoc(T, 'Complete a booking (door free)', op, {
    data: booking,
    errors: [404, 409, 422],
  }),
  cancel: staffDoc(T, 'Cancel a booking', op, { data: booking, errors: [404, 409, 422] }),
  staging: staffDoc(T, 'Staging areas', view),
  createStaging: staffDoc(T, 'Add staging area', conf, { status: 201, errors: [404, 409, 422] }),
  updateStaging: staffDoc(T, 'Edit staging area', conf),
  deleteStaging: staffDoc(T, 'Delete staging area', conf, { status: 204 }),
  slots: staffDoc(T, 'Yard slots', view),
  createSlot: staffDoc(T, 'Add yard slot', conf, { status: 201, errors: [404, 409, 422] }),
  updateSlot: staffDoc(T, 'Edit yard slot', conf, {
    errors: [404, 409, 422],
    description: 'Vehicle class, AVAILABLE ↔ BLOCKED (not while occupied).',
  }),
  deleteSlot: staffDoc(T, 'Delete yard slot', conf, { status: 204, errors: [404, 409, 422] }),
  occupy: staffDoc(T, 'Occupy a yard slot', op, {
    errors: [404, 409, 422],
    description: 'AVAILABLE → OCCUPIED with the vehicle number (manual until Gate, W5).',
  }),
  release: staffDoc(T, 'Release a yard slot', op, { errors: [404, 409, 422] }),
} satisfies Record<string, RouteDocs>;
