import type { Logger } from '@farmx/common/logger';
import type { Cradle } from '@fastify/awilix';
import { type AwilixContainer, asValue, createContainer } from 'awilix';

import type { GatewayConfig } from './config/index.js';

declare module '@fastify/awilix' {
  interface Cradle {
    config: Readonly<GatewayConfig>;
    logger: Logger;
  }
}

export interface ContainerDeps {
  config: Readonly<GatewayConfig>;
  logger: Logger;
}

export function createAppContainer({ config, logger }: ContainerDeps): AwilixContainer<Cradle> {
  const container = createContainer<Cradle>({ strict: true });
  container.register({ config: asValue(config), logger: asValue(logger) });
  return container;
}
