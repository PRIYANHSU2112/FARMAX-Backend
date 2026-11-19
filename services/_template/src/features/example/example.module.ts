import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { ExampleController } from './example.controller.js';
import { ExampleRepository } from './example.repository.js';
import { exampleRoutes } from './example.routes.js';
import { ExampleService } from './example.service.js';

// DI keys are prefixed with the module name (rule 12).
declare module '@fastify/awilix' {
  interface Cradle {
    exampleRepository: ExampleRepository;
    exampleService: ExampleService;
    exampleController: ExampleController;
  }
}

export const exampleModule = defineModule({
  name: 'example',
  prefix: '/examples',
  register: (container) => {
    container.register({
      exampleRepository: asClass(ExampleRepository).singleton(),
      exampleService: asClass(ExampleService).singleton(),
      exampleController: asClass(ExampleController).singleton(),
    });
  },
  routes: exampleRoutes,
});
