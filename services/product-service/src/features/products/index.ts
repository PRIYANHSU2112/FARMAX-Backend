// Public API of the products feature (products, variants, media, lookups, diseases, projections).
export {
  diseasesAdminModule,
  diseasesModule,
  lookupsAdminModule,
  lookupsModule,
  productsAdminModule,
  productsInternalModule,
  productsModule,
} from './products.module.js';
export type { ProductsService } from './products.service.js';
export { ADMIN_PRODUCTS_TAG, PRODUCTS_TAG } from './products.docs.js';
export { ADMIN_LOOKUPS_TAG, LOOKUPS_TAG } from './lookups.docs.js';
export { ADMIN_DISEASES_TAG, DISEASES_TAG } from './diseases.docs.js';
