import type { ProductCard } from '../../adapters/product-client.js';

export interface WishlistRow {
  id: string;
  productId: string;
  createdAt: Date;
}

/** One saved product, hydrated with product-service's card (null when unknown or unreachable). */
export interface WishlistItemView {
  id: string;
  productId: string;
  addedAt: Date;
  /** false = unpublished / inactive / deleted product, or product data unavailable right now. */
  available: boolean;
  product: ProductCard | null;
}

export interface WishlistQuery {
  cursor?: string;
  limit: number;
}

export interface AddWishlistInput {
  productId: string;
}
