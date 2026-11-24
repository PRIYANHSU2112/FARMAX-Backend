import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { HomeAdminService } from './home.admin.service.js';
import { HomeContextService } from './home.context.js';
import { HomeController } from './home.controller.js';
import { HomeFeedsService } from './home.feeds.js';
import { HomeRepository } from './home.repository.js';
import { homeAdminRoutes, homeRoutes } from './home.routes.js';
import { HomeService } from './home.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    homeRepository: HomeRepository;
    homeService: HomeService;
    homeAdminService: HomeAdminService;
    homeFeedsService: HomeFeedsService;
    homeContextService: HomeContextService;
    homeController: HomeController;
  }
}

export const homeModule = defineModule({
  name: 'home',
  prefix: '/home',
  register: (container) => {
    container.register({
      homeRepository: asClass(HomeRepository).singleton(),
      homeService: asClass(HomeService).singleton(),
      homeAdminService: asClass(HomeAdminService).singleton(),
      homeFeedsService: asClass(HomeFeedsService).singleton(),
      homeContextService: asClass(HomeContextService).singleton(),
      homeController: asClass(HomeController).singleton(),
    });
  },
  routes: homeRoutes,
});

export const homeAdminModule = defineModule({
  name: 'home-admin',
  prefix: '/admin/home',
  routes: homeAdminRoutes,
});
