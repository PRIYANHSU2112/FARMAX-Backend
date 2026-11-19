import { type ServiceModule, defineModule } from '@farmx/common/server';

import type { ServiceUrls } from '../../config/services.js';
import { createRouteMap, proxyRoutes } from './route-map.js';

export const createProxyModule = (config: ServiceUrls): ServiceModule =>
  defineModule({ name: 'proxy', routes: proxyRoutes(createRouteMap(config)) });
