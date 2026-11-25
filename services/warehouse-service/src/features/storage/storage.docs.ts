import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { IF_VERSION, staffDoc } from '../../docs/shared.js';

export const ADMIN_STORAGE_TAG = 'Admin Warehouse Storage';

const zone = Joi.object({
  id: Joi.string().guid(),
  code: Joi.string().example('A'),
  name: Joi.string().example('Feed'),
  temperatureClass: Joi.string().example('AMB'),
  minTempC: Joi.string().allow(null),
  maxTempC: Joi.string().allow(null),
  isSecure: Joi.boolean().description('Secure / vault zone for restricted SKUs'),
  isFoodGrade: Joi.boolean(),
  productCategoryIds: Joi.array().items(Joi.string().guid()),
  status: Joi.string(),
  sortOrder: Joi.number().integer(),
  version: Joi.number().integer(),
  rackCount: Joi.number().integer(),
  binCount: Joi.number().integer(),
}).meta({ className: 'StorageZone' });

const rack = Joi.object({
  id: Joi.string().guid(),
  zoneId: Joi.string().guid(),
  zoneCode: Joi.string(),
  code: Joi.string().example('A-01'),
  maxWeightKg: Joi.string().example('3000.00'),
  volumeM3: Joi.string().example('12.000'),
  binCount: Joi.number().integer(),
  availableWeightKg: Joi.string(),
  availableVolumeM3: Joi.string().example('7.500'),
  availablePct: Joi.number().example(62.5),
  status: Joi.string(),
  version: Joi.number().integer(),
}).meta({ className: 'StorageRack' });

const bin = Joi.object({
  id: Joi.string().guid(),
  code: Joi.string().example('A-01-01'),
  zoneId: Joi.string().guid(),
  zoneCode: Joi.string(),
  rackId: Joi.string().guid(),
  rackCode: Joi.string(),
  temperatureClass: Joi.string(),
  maxWeightKg: Joi.string(),
  volumeM3: Joi.string(),
  usedWeightKg: Joi.string().description('0 until put-away (W8)'),
  usedVolumeM3: Joi.string(),
  availableVolumeM3: Joi.string(),
  availablePct: Joi.number(),
  status: Joi.string(),
}).meta({ className: 'StorageBin' });

const conf = 'warehouse.configure';
const T = ADMIN_STORAGE_TAG;

export const STORAGE_DOCS = {
  layout: staffDoc(T, 'Storage layout grid (W2.05)', 'warehouse.view', {
    description: 'Zones → racks → bins (codes, temperature class, status) for the layout visual.',
  }),
  zones: staffDoc(T, 'Zones table', 'warehouse.view', { data: Joi.array().items(zone) }),
  createZone: staffDoc(T, 'Add zone', conf, {
    status: 201,
    data: zone,
    errors: [404, 409, 422],
    description:
      'Code unique per warehouse (409 DUPLICATE_CODE). Product types = catalog category ids.',
  }),
  updateZone: staffDoc(T, 'Edit zone', conf, {
    data: zone,
    errors: [404, 409, 422],
    description: IF_VERSION,
  }),
  deleteZone: staffDoc(T, 'Delete zone', conf, {
    status: 204,
    errors: [404, 409, 422],
    description: '409 NOT_EMPTY while it has racks.',
  }),
  racks: staffDoc(T, 'Racks table', 'warehouse.view', {
    data: Joi.array().items(rack),
    description: 'Available space = rack limits not yet given to bins.',
  }),
  createRack: staffDoc(T, 'Add rack', conf, {
    status: 201,
    data: rack,
    errors: [404, 409, 422],
    description:
      'Code defaults to the next free <zone>-NN. `generateBins` also creates N bins (<rack>-01 …); their limits must fit the rack (409 RACK_CAPACITY_EXCEEDED).',
  }),
  updateRack: staffDoc(T, 'Edit rack', conf, {
    data: rack,
    errors: [404, 409, 422],
    description: `New limits must still cover its bins. ${IF_VERSION}`,
  }),
  deleteRack: staffDoc(T, 'Delete rack', conf, {
    status: 204,
    errors: [404, 409, 422],
    description: '409 NOT_EMPTY while it has bins.',
  }),
  bins: staffDoc(T, 'Bins table', 'warehouse.view', {
    data: bin,
    paginated: true,
    description:
      'Filter by rack or zone; cursor = last bin code. Used space stays 0 until put-away (W8).',
  }),
  createBins: staffDoc(T, 'Add bins', conf, {
    status: 201,
    data: Joi.array().items(bin),
    errors: [404, 409, 422],
    description:
      'Explicit `bins`, or `count` auto-coded bins with the same limits (≤ 200). The sum of bin limits never exceeds the rack (409 RACK_CAPACITY_EXCEEDED).',
  }),
  updateBin: staffDoc(T, 'Edit bin', conf, { data: bin, errors: [404, 409, 422] }),
  deleteBin: staffDoc(T, 'Delete bin', conf, {
    status: 204,
    errors: [404, 409, 422],
    description: '409 BIN_IN_USE once it holds stock.',
  }),
} satisfies Record<string, RouteDocs>;
