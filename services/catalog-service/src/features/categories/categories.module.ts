import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { CategoriesController } from './categories.controller.js';
import { CategoriesRepository } from './categories.repository.js';
import { categoriesInternalRoutes } from './categories.internal.routes.js';
import { categoriesAdminRoutes, categoriesRoutes } from './categories.routes.js';
import { CategoriesService } from './categories.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    categoriesRepository: CategoriesRepository;
    categoriesService: CategoriesService;
    categoriesController: CategoriesController;
  }
}

export const categoriesModule = defineModule({
  name: 'categories',
  prefix: '/catalog/categories',
  register: (container) => {
    container.register({
      categoriesRepository: asClass(CategoriesRepository).singleton(),
      // Singleton: holds the in-process tree snapshot and its built index.
      categoriesService: asClass(CategoriesService).singleton(),
      categoriesController: asClass(CategoriesController).singleton(),
    });
  },
  routes: categoriesRoutes,
});

export const categoriesAdminModule = defineModule({
  name: 'categories-admin',
  prefix: '/admin/catalog/categories',
  routes: categoriesAdminRoutes,
});

export const categoriesInternalModule = defineModule({
  name: 'categories-internal',
  prefix: '/internal/catalog/categories',
  routes: categoriesInternalRoutes,
});
