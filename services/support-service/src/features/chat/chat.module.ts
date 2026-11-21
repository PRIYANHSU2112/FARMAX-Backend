import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { chatRoutes } from './chat.routes.js';
import { ChatService } from './chat.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    chatService: ChatService;
  }
}

/** Live chat: connect tokens + the support WebSocket (`/support/chat/ws-token`, `/support/chat/ws`). */
export const chatModule = defineModule({
  name: 'chat',
  prefix: '/support/chat',
  register: (container) => {
    container.register({ chatService: asClass(ChatService).singleton() });
  },
  routes: chatRoutes,
});
