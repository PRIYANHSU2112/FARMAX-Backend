import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { ReviewRepository } from './review.repository.js';
import { reviewAdminRoutes, reviewRoutes } from './review.routes.js';
import { ReviewService } from './review.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    reviewRepository: ReviewRepository;
    reviewService: ReviewService;
  }
}

export const reviewModule = defineModule({
  name: 'review',
  prefix: '/farms',
  register: (container) => {
    container.register({
      reviewRepository: asClass(ReviewRepository).singleton(),
      reviewService: asClass(ReviewService).singleton(),
    });
  },
  routes: reviewRoutes,
});

export const reviewAdminModule = defineModule({
  name: 'review-admin',
  prefix: '/admin/farms',
  routes: reviewAdminRoutes,
});
