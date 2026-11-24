import Joi from 'joi';
import { ID } from '../../middleware/http.js';
import { PAGING } from '../../middleware/paging.js';
import { OWNER_TYPES, STOCK_STATUSES } from './stock.rules.js';

const DATE = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const FRESH = Joi.boolean().truthy('1').falsy('0').default(false);
const Q = Joi.string().trim().min(1).max(80);

export const whQuery = { querystring: Joi.object({ warehouseId: ID, fresh: FRESH }) };

export const byCategoryQuery = {
  querystring: Joi.object({
    warehouseId: ID,
    top: Joi.number().integer().min(1).max(12).default(4),
    fresh: FRESH,
  }),
};

export const freshQuery = { querystring: Joi.object({ fresh: FRESH }) };

export const productsQuery = {
  querystring: Joi.object({
    q: Q,
    categoryId: ID,
    brandId: ID,
    vendorId: ID,
    warehouseId: ID,
    stockState: Joi.string().valid('ok', 'low', 'out'),
    sort: Joi.string().valid('name', 'available', 'onHand').default('name'),
    ...PAGING,
  }),
};

export const recordsQuery = {
  querystring: Joi.object({
    q: Q,
    brandId: ID,
    categoryId: ID,
    vendorId: ID,
    batchNo: Joi.string().trim().max(40),
    binCode: Joi.string().trim().max(24),
    expiry: Joi.string().valid('expired', '30d', '90d', 'later', 'unknown'),
    status: Joi.string().valid(...STOCK_STATUSES),
    minAvailable: Joi.number().integer().min(0),
    maxAvailable: Joi.number().integer().min(0),
    dateType: Joi.string().valid('receipt', 'expiry', 'mfg').default('receipt'),
    from: DATE,
    to: DATE,
    warehouseId: ID,
    ownerType: Joi.string().valid(...OWNER_TYPES),
    sort: Joi.string().valid('expiry', 'available', 'onHand', 'received').default('expiry'),
    ...PAGING,
  }),
};

export const filterOptionsQuery = {
  querystring: Joi.object({
    field: Joi.string().valid('brand', 'category', 'vendor', 'batch', 'bin').required(),
    q: Q,
    warehouseId: ID,
  }),
};

export const variantParams = { params: Joi.object({ variantId: ID.required() }) };
export const variantWhQuery = { ...variantParams, querystring: Joi.object({ warehouseId: ID }) };
export const variantPagedQuery = {
  ...variantParams,
  querystring: Joi.object({ warehouseId: ID, ...PAGING }),
};
export const variantUnitsQuery = {
  ...variantParams,
  querystring: Joi.object({
    warehouseId: ID,
    batchId: ID,
    status: Joi.string().valid(...STOCK_STATUSES),
    ...PAGING,
  }),
};

export const batchParams = { params: Joi.object({ batchId: ID.required() }) };
export const batchWhQuery = { ...batchParams, querystring: Joi.object({ warehouseId: ID }) };
export const batchUnitsQuery = {
  ...batchParams,
  querystring: Joi.object({
    warehouseId: ID,
    binId: ID,
    status: Joi.string().valid(...STOCK_STATUSES),
    ...PAGING,
  }),
};
export const batchMovesQuery = {
  ...batchParams,
  querystring: Joi.object({ warehouseId: ID, ...PAGING }),
};

export const qrParams = { params: Joi.object({ qrCode: Joi.string().trim().max(64).required() }) };

export const movementsQuery = {
  querystring: Joi.object({
    type: Joi.string().valid(
      'RECEIPT',
      'OPENING',
      'QC_RELEASE',
      'QC_HOLD',
      'ALLOCATE',
      'DEALLOCATE',
      'PICK',
      'PACK',
      'ISSUE',
      'TRANSFER_OUT',
      'TRANSFER_IN',
      'RETURN',
      'RESTOCK',
      'ADJUSTMENT',
      'DAMAGE',
      'QUARANTINE',
      'EXPIRE',
      'WRITE_OFF',
      'BIN_MOVE',
      'OWNER_FIX',
      'RELABEL',
      'ROLLBACK_REPLAY',
      'STATUS_CHANGE',
    ),
    warehouseId: ID,
    variantId: ID,
    batchId: ID,
    refNo: Joi.string().trim().max(40),
    from: DATE,
    to: DATE,
    ...PAGING,
  }),
};

export const idParam = { params: Joi.object({ id: ID.required() }) };

export const ownershipQuery = {
  querystring: Joi.object({
    model: Joi.string().valid(...OWNER_TYPES),
    vendorId: ID,
    q: Q,
    warehouseId: ID,
    ...PAGING,
  }),
};

export const alertsQuery = {
  querystring: Joi.object({
    type: Joi.string().valid('all', 'low', 'out').default('all'),
    warehouseId: ID,
    q: Q,
    ...PAGING,
  }),
};

export const planQuery = {
  querystring: Joi.object({
    month: Joi.string().pattern(/^\d{4}-\d{2}$/),
    warehouseId: ID,
    vendorId: ID,
    brandId: ID,
    q: Q,
    ...PAGING,
  }),
};

export const planItemQuery = {
  querystring: Joi.object({ variantId: ID.required(), warehouseId: ID.required() }),
};
