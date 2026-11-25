import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import {
  ADMIN_CUSTOMERS_TAG,
  AUTH_ADMIN,
  AUTH_CUSTOMER,
  IDS,
  PERMISSION_VIEW,
  READ_RATE,
  WRITE_RATE,
  ok,
} from '../../docs/shared.js';

export const WISHLIST_TAG = 'Me · Wishlist';

// ── Schemas ──

const productCard = Joi.object({
  id: Joi.string().guid(),
  name: Joi.string().example('Lasota ND Vaccine'),
  slug: Joi.string().example('lasota-nd-vaccine'),
  imageUrl: Joi.string().uri().allow(null),
  priceRange: Joi.object({ min: Joi.string().allow(null), max: Joi.string().allow(null) }),
  inStock: Joi.boolean(),
  available: Joi.boolean(),
})
  .unknown(true)
  .description('product-service storefront card (all its fields are passed through)')
  .meta({ className: 'WishlistProductCard' });

const item = Joi.object({
  id: Joi.string().guid(),
  productId: Joi.string().guid(),
  addedAt: Joi.date(),
  available: Joi.boolean().description(
    'false = unpublished / inactive / deleted product, or product data temporarily unavailable',
  ),
  product: productCard.allow(null),
}).meta({ className: 'WishlistItem' });

// ── Examples ──

const at = '2026-11-16T09:30:00.000Z';
const card = {
  id: IDS.product,
  name: 'Lasota ND Vaccine',
  slug: 'lasota-nd-vaccine',
  imageUrl: 'https://cdn.farmx.in/products/lasota.webp',
  priceRange: { min: '240.00', max: '890.00' },
  inStock: true,
  available: true,
};
const itemEx = {
  id: IDS.wish,
  productId: IDS.product,
  addedAt: at,
  available: true,
  product: card,
};
const page = { nextCursor: null, limit: 20 };

const me = (extra: Omit<RouteDocs, 'tag' | 'auth'>): RouteDocs => ({
  tag: WISHLIST_TAG,
  auth: AUTH_CUSTOMER,
  ...extra,
});

export const WISHLIST_DOCS = {
  list: me({
    operationId: 'listMyWishlist',
    summary: 'My wishlist (newest first)',
    description:
      'Cursor pagination (`limit` ≤ 50; pass `meta.nextCursor` as `cursor`). Products are hydrated in one cached batch; products no longer on sale stay listed with `available: false`.',
    rateLimit: READ_RATE,
    success: {
      status: 200,
      description: 'A page of wishlist items',
      data: item,
      paginated: true,
      example: ok([itemEx], page),
    },
    errors: [422],
  }),
  ids: me({
    operationId: 'listMyWishlistProductIds',
    summary: 'Product ids in my wishlist',
    description:
      'Lightweight list for heart icons on product cards (home rails and listings), newest first, at most 500 ids; `meta.truncated` = there are more.',
    rateLimit: WRITE_RATE,
    success: {
      status: 200,
      description: 'Product ids',
      data: Joi.object({ productIds: Joi.array().items(Joi.string().guid()) }),
      meta: Joi.object({ truncated: Joi.boolean() }),
      example: ok({ productIds: [IDS.product] }, { truncated: false }),
    },
  }),
  add: me({
    operationId: 'addToMyWishlist',
    summary: 'Save a product',
    description:
      'Idempotent: **201** when added, **200** when it was already saved (same item returned). The product must exist and be on sale. Max 200 products.',
    rateLimit: WRITE_RATE,
    requestExample: { productId: IDS.product },
    success: {
      status: 201,
      description: 'Added (200 = already in the wishlist)',
      data: item,
      example: ok(itemEx),
    },
    errors: [404, 409, 422, 503],
    errorExamples: {
      404: { message: 'Product not found', details: { reason: 'PRODUCT_NOT_FOUND' } },
      409: {
        summary: 'WISHLIST_FULL',
        message: 'Your wishlist can hold at most 200 products',
        details: { reason: 'WISHLIST_FULL', max: 200 },
      },
      422: {
        summary: 'Product not on sale',
        message: 'Product is not available',
        details: { issues: [{ path: 'body.productId', message: 'product is not available' }] },
      },
      503: { message: 'Product service unavailable' },
    },
  }),
  remove: me({
    operationId: 'removeFromMyWishlist',
    summary: 'Remove a product',
    description: 'Idempotent: 204 even when it was not saved.',
    rateLimit: WRITE_RATE,
    success: { status: 204, description: 'Removed' },
    errors: [422],
  }),
  clear: me({
    operationId: 'clearMyWishlist',
    summary: 'Clear my wishlist',
    rateLimit: WRITE_RATE,
    success: { status: 204, description: 'Cleared' },
  }),
  adminList: {
    tag: ADMIN_CUSTOMERS_TAG,
    operationId: 'adminCustomerWishlist',
    summary: 'A customer’s wishlist (support)',
    auth: AUTH_ADMIN,
    permission: PERMISSION_VIEW,
    success: {
      status: 200,
      description: 'A page of wishlist items',
      data: item,
      paginated: true,
      example: ok([itemEx], page),
    },
    errors: [422],
  },
} satisfies Record<string, RouteDocs>;
