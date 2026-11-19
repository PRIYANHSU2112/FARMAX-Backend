// Public API of the categories feature.
export {
  categoriesAdminModule,
  categoriesInternalModule,
  categoriesModule,
} from './categories.module.js';
export type { CategoriesService } from './categories.service.js';
export type { CategoryRow } from './categories.types.js';
export { ADMIN_CATEGORIES_TAG, CATEGORIES_TAG } from './categories.docs.js';
