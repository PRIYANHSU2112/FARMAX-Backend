import { defineModule } from '@farmx/common/server';
import type { Cradle } from '@fastify/awilix';
import { asClass, asFunction } from 'awilix';

import type { EventHandlerMap } from '../../adapters/events.js';
import { UserDirectoryClient } from '../../adapters/user-directory.js';
import { ReviewsController } from './reviews.controller.js';
import { createReviewEventHandlers } from './reviews.events.js';
import { ModerationService } from './reviews.moderation.js';
import { ReviewsRepository } from './reviews.repository.js';
import {
  reviewsAdminRoutes,
  reviewsCustomerRoutes,
  reviewsProductRoutes,
} from './reviews.routes.js';
import { maskName } from './reviews.rules.js';
import { ReviewsService } from './reviews.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    reviewsRepository: ReviewsRepository;
    reviewsService: ReviewsService;
    moderationService: ModerationService;
    reviewsController: ReviewsController;
    /** Masked reviewer names from auth-service (cached). */
    userDirectoryClient: UserDirectoryClient;
    /** Inbox handlers by routing key (order.delivered.v1 → review eligibility). */
    reviewEventHandlers: EventHandlerMap;
  }
}

/** `/catalog/products/:slugOrId/reviews|rating-summary` (storefront + write a review). */
export const reviewsModule = defineModule({
  name: 'reviews',
  prefix: '/catalog/products',
  register: (container) => {
    container.register({
      reviewsRepository: asClass(ReviewsRepository).singleton(),
      reviewsService: asClass(ReviewsService).singleton(),
      moderationService: asClass(ModerationService).singleton(),
      reviewsController: asClass(ReviewsController).singleton(),
      userDirectoryClient: asFunction(
        (cradle: Cradle) =>
          new UserDirectoryClient({
            config: cradle.config,
            logger: cradle.logger,
            redis: () => cradle.redis,
            mask: (fullName) => maskName(fullName),
          }),
      ).singleton(),
      reviewEventHandlers: asFunction(createReviewEventHandlers).singleton(),
    });
  },
  routes: reviewsProductRoutes,
});

export const reviewsCustomerModule = defineModule({
  name: 'reviews-customer',
  prefix: '/catalog/reviews',
  routes: reviewsCustomerRoutes,
});

export const reviewsAdminModule = defineModule({
  name: 'reviews-admin',
  prefix: '/admin/catalog/reviews',
  routes: reviewsAdminRoutes,
});
