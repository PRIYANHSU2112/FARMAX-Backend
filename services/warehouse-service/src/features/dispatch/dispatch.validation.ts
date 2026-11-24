import Joi from 'joi';

import { ID, REASON, VERSION } from '../../middleware/http.js';
import { PAGING } from '../../middleware/paging.js';

const DATE = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const PIN = Joi.string().pattern(/^[1-9]\d{5}$/);
const PHONE = Joi.string()
  .trim()
  .pattern(/^\+?\d{10,15}$/);
const STOP = Joi.object({
  name: Joi.string().trim().min(1).max(120).required(),
  lat: Joi.number().min(-90).max(90).allow(null),
  lng: Joi.number().min(-180).max(180).allow(null),
  shipmentId: ID.allow(null),
});
const VEHICLE_CLASS = Joi.string().valid('MINI_TRUCK', 'TRUCK', 'HEAVY_TRUCK', 'ANY');
const FLEET_STATUS = Joi.string().valid('ACTIVE', 'INACTIVE', 'MAINTENANCE');

export const idParams = { params: Joi.object({ id: ID.required() }) };
export const shipmentParams = { params: Joi.object({ shipmentId: ID.required() }) };

export const routesQuery = {
  querystring: Joi.object({
    warehouseId: ID,
    active: Joi.boolean().truthy('1').falsy('0'),
    q: Joi.string().trim().max(40),
  }),
};
export const routeCreate = {
  body: Joi.object({
    warehouseId: ID.required(),
    code: Joi.string()
      .trim()
      .pattern(/^[A-Za-z0-9#][A-Za-z0-9#/_-]{0,19}$/)
      .required(),
    name: Joi.string().trim().min(2).max(120).required(),
    corridorName: Joi.string().trim().max(120).allow(null),
    pinCodes: Joi.array().items(PIN).max(2000).default([]),
    districts: Joi.array().items(Joi.string().trim().max(80)).max(100),
    stops: Joi.array().items(STOP).max(100),
  }),
};
export const routePatch = {
  ...idParams,
  body: Joi.object({
    name: Joi.string().trim().min(2).max(120),
    corridorName: Joi.string().trim().max(120).allow(null),
    pinCodes: Joi.array().items(PIN).max(2000),
    districts: Joi.array().items(Joi.string().trim().max(80)).max(100),
    stops: Joi.array().items(STOP).max(100),
    isActive: Joi.boolean(),
    expectedVersion: VERSION.required(),
  }).min(2),
};

export const carriersQuery = {
  querystring: Joi.object({
    type: Joi.string().valid('OWN_FLEET', 'THREE_PL'),
    status: FLEET_STATUS,
    q: Joi.string().trim().max(60),
  }),
};
export const carrierCreate = {
  body: Joi.object({
    name: Joi.string().trim().min(2).max(120).required(),
    type: Joi.string().valid('OWN_FLEET', 'THREE_PL').required(),
    phone: PHONE.allow(null),
    gstin: Joi.string().trim().uppercase().length(15).allow(null),
  }),
};
export const carrierPatch = {
  ...idParams,
  body: Joi.object({
    name: Joi.string().trim().min(2).max(120),
    phone: PHONE.allow(null),
    gstin: Joi.string().trim().uppercase().length(15).allow(null),
    status: FLEET_STATUS,
    expectedVersion: VERSION.required(),
  }).min(2),
};

export const vehiclesQuery = {
  querystring: Joi.object({
    warehouseId: ID,
    status: FLEET_STATUS,
    carrierId: ID,
    q: Joi.string().trim().max(20),
    available: Joi.boolean().truthy('1').falsy('0'),
  }),
};
export const vehicleCreate = {
  body: Joi.object({
    regNo: Joi.string().trim().min(4).max(20).required(),
    carrierId: ID.allow(null),
    warehouseId: ID.allow(null),
    vehicleClass: VEHICLE_CLASS.required(),
    capacityKg: Joi.number().min(1).max(100_000).required(),
    refrigerated: Joi.boolean(),
    sensorsEnabled: Joi.boolean(),
  }),
};
export const vehiclePatch = {
  ...idParams,
  body: Joi.object({
    carrierId: ID.allow(null),
    warehouseId: ID.allow(null),
    vehicleClass: VEHICLE_CLASS,
    capacityKg: Joi.number().min(1).max(100_000),
    refrigerated: Joi.boolean(),
    sensorsEnabled: Joi.boolean(),
    status: FLEET_STATUS,
    expectedVersion: VERSION.required(),
  }).min(2),
};

export const driversQuery = {
  querystring: Joi.object({
    warehouseId: ID,
    status: FLEET_STATUS,
    carrierId: ID,
    q: Joi.string().trim().max(60),
  }),
};
export const driverCreate = {
  body: Joi.object({
    name: Joi.string().trim().min(2).max(120).required(),
    phone: PHONE.required(),
    userId: ID.allow(null),
    licenceNo: Joi.string().trim().max(30).allow(null),
    kycStatus: Joi.string().valid('PENDING', 'VERIFIED', 'REJECTED'),
    carrierId: ID.allow(null),
    warehouseId: ID.allow(null),
  }),
};
export const driverPatch = {
  ...idParams,
  body: Joi.object({
    name: Joi.string().trim().min(2).max(120),
    phone: PHONE,
    userId: ID.allow(null),
    licenceNo: Joi.string().trim().max(30).allow(null),
    kycStatus: Joi.string().valid('PENDING', 'VERIFIED', 'REJECTED'),
    carrierId: ID.allow(null),
    warehouseId: ID.allow(null),
    status: FLEET_STATUS,
    expectedVersion: VERSION.required(),
  }).min(2),
};

export const tripCreate = {
  body: Joi.object({
    warehouseId: ID.required(),
    shipmentIds: Joi.array().items(ID).min(1).max(100).unique().required(),
    type: Joi.string().valid('STANDARD', 'BULK'),
    vehicleId: ID.allow(null),
    driverId: ID.allow(null),
    carrierId: ID.allow(null),
    routeId: ID.allow(null),
    dockDoorId: ID.allow(null),
    dockBookingId: ID.allow(null),
    routeStops: Joi.array().items(STOP).max(100),
    plannedDepartAt: Joi.date().iso().allow(null),
    etaAt: Joi.date().iso().allow(null),
    note: Joi.string().trim().max(500).allow(null),
  }),
};
export const tripsQuery = {
  querystring: Joi.object({
    warehouseId: ID,
    status: Joi.string().valid('PLANNED', 'LOADING', 'DEPARTED', 'COMPLETED', 'CANCELLED'),
    type: Joi.string().valid('STANDARD', 'BULK'),
    vehicleId: ID,
    q: Joi.string().trim().max(20),
    ...PAGING,
  }),
};
export const tripShipments = {
  ...idParams,
  body: Joi.object({ shipmentIds: Joi.array().items(ID).min(1).max(100).unique().required() }),
};
export const tripShipmentParams = {
  params: Joi.object({ id: ID.required(), shipmentId: ID.required() }),
};
export const loadingSchema = {
  ...idParams,
  body: Joi.object({
    gateIn: Joi.boolean(),
    loadedPct: Joi.number().integer().min(0).max(100),
    shipments: Joi.array()
      .items(
        Joi.object({
          shipmentId: ID.required(),
          loadedKg: Joi.number().min(0).max(100_000).required(),
        }),
      )
      .max(100),
  }).min(1),
};
export const weighSchema = {
  ...idParams,
  body: Joi.object({
    grossKg: Joi.number().min(1).max(200_000).required(),
    tareKg: Joi.number().min(0).max(200_000).required(),
    slipNo: Joi.string().trim().max(40).allow(null),
    receipt: Joi.string().trim().min(20).max(4000).allow(null),
  }),
};
export const departSchema = {
  ...idParams,
  body: Joi.object({
    etaAt: Joi.date().iso().allow(null),
    note: Joi.string().trim().max(500).allow(null),
  })
    .empty(null)
    .default({}),
};
export const cancelSchema = { ...idParams, body: Joi.object({ reason: REASON.required() }) };
export const reassignSchema = {
  ...idParams,
  body: Joi.object({ vehicleId: ID, driverId: ID, reason: REASON.required() }).or(
    'vehicleId',
    'driverId',
  ),
};
export const pingSchema = {
  ...idParams,
  body: Joi.object({
    lat: Joi.number().min(-90).max(90).required(),
    lng: Joi.number().min(-180).max(180).required(),
    speedKmh: Joi.number().min(0).max(200).allow(null),
    remainingKm: Joi.number().min(0).max(5000).allow(null),
    network: Joi.string().trim().max(10).allow(null),
    at: Joi.date().iso().max('now').allow(null),
  }),
};
export const weighRecentQuery = {
  querystring: Joi.object({
    warehouseId: ID,
    limit: Joi.number().integer().min(1).max(50).default(10),
  }),
};

export const dispatchedQuery = {
  querystring: Joi.object({
    status: Joi.string().valid('DISPATCHED', 'OUT_FOR_DELIVERY'),
    q: Joi.string().trim().min(1).max(60),
    from: DATE,
    to: DATE,
    warehouseId: ID,
    ...PAGING,
  }),
};
export const bulkKpisQuery = { querystring: Joi.object({ warehouseId: ID }) };
export const bulkOrdersQuery = {
  querystring: Joi.object({
    tab: Joi.string().valid('all', 'direct', 'ready', 'transit').default('all'),
    q: Joi.string().trim().min(1).max(60),
    status: Joi.string().valid(
      'RELEASED',
      'ALLOCATED',
      'ASSIGNED',
      'PICKING',
      'PACKING',
      'QC',
      'READY_TO_DISPATCH',
      'DISPATCHED',
      'OUT_FOR_DELIVERY',
    ),
    warehouseId: ID,
    ...PAGING,
  }),
};
export const whRequired = { querystring: Joi.object({ warehouseId: ID.required() }) };
