import { ForbiddenError, ServiceUnavailableError } from '@farmx/common/errors';
import { type RealtimeConnection, RealtimeServer } from '@farmx/infra/realtime';
import { authKeys, supportKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';
import type { FastifyRequest } from 'fastify';

import { wsOrigins } from '../../config/index.js';
import { appOfUserType } from '../../middleware/guards.js';
import { createChatHandlers } from './chat.handlers.js';

export const WS_PATH = '/support/chat/ws';
const PRESENCE_REFRESH_MS = 45_000;

type Deps = Pick<
  Cradle,
  | 'config'
  | 'logger'
  | 'redis'
  | 'realtimeHub'
  | 'wsTokens'
  | 'accessClient'
  | 'settingsService'
  | 'agentsService'
  | 'ticketsService'
>;

/**
 * Support live chat over the shared realtime layer (`@farmx/infra/realtime`): this class only
 * decides WHO may connect (connect tokens + tags), re-validates sessions, and keeps agent
 * presence. Sockets, limits, rooms and fan-out are the shared layer's job.
 */
export class ChatService {
  readonly server: RealtimeServer;
  private readonly agentSockets = new Map<string, Set<RealtimeConnection>>();
  private presenceTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: Deps) {
    this.server = new RealtimeServer({
      path: WS_PATH,
      logger: deps.logger,
      redis: () => deps.redis,
      hub: deps.realtimeHub,
      tokens: deps.wsTokens,
      handlers: createChatHandlers(deps),
      allowedOrigins: wsOrigins(deps.config),
      keys: { connections: supportKeys.wsConnections, rateLimit: supportKeys.wsRate },
      revalidate: (p) => this.stillValid(p.userId, p.sessionId, p.tags.includes('agent')),
      onConnect: (conn) => {
        this.trackAgent(conn, true);
      },
      onDisconnect: (conn) => {
        this.trackAgent(conn, false);
      },
    });
  }

  /**
   * Single-use 60 s token for `GET /v1/support/chat/ws?token=`. `as: agent` needs staff +
   * support.view (tag `agent`; `agent:manage` with support.manage); requesters need chat enabled.
   */
  async issueToken(request: FastifyRequest, as: 'requester' | 'agent') {
    const user = request.user;
    if (user === null) throw new ForbiddenError();
    let app: string;
    let tags: string[];
    if (as === 'agent') {
      if (
        user.userType !== 'INTERNAL' ||
        !(await this.deps.accessClient.hasPermission(user.id, 'support.view'))
      )
        throw new ForbiddenError('Agent console access needs support.view');
      const manage = await this.deps.accessClient.hasPermission(user.id, 'support.manage');
      app = 'ADMIN';
      tags = manage ? ['agent', 'agent:manage'] : ['agent'];
    } else {
      if (!(await this.deps.settingsService.current()).chat.enabled)
        throw new ServiceUnavailableError('Live chat is turned off; raise a ticket instead');
      app = appOfUserType(user.userType);
      tags = ['requester'];
    }
    const { token, expiresIn } = await this.deps.wsTokens.issue({
      userId: user.id,
      userType: user.userType,
      sessionId: user.sessionId,
      app,
      tags,
    });
    return { token, expiresIn, path: `/v1${WS_PATH}?token=${token}` };
  }

  start(httpServer: Parameters<RealtimeServer['attach']>[0]): void {
    this.server.attach(httpServer);
    this.presenceTimer = setInterval(() => {
      void this.deps.agentsService.markOnline(this.agentSockets.keys());
    }, PRESENCE_REFRESH_MS);
    this.presenceTimer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.presenceTimer);
    await this.server.close();
  }

  /** Session revoked (logout, deletion, compromise) or agent access withdrawn → close. */
  private async stillValid(userId: string, sessionId: string, agent: boolean): Promise<boolean> {
    const revoked = await this.deps.redis.exists(authKeys.revokedSid(sessionId));
    if (revoked > 0) return false;
    return agent ? this.deps.accessClient.hasPermission(userId, 'support.view') : true;
  }

  private trackAgent(conn: RealtimeConnection, open: boolean): void {
    if (!conn.hasTag('agent')) return;
    const userId = conn.principal.userId;
    let set = this.agentSockets.get(userId);
    if (open) {
      if (set === undefined) this.agentSockets.set(userId, (set = new Set()));
      set.add(conn);
      void this.deps.agentsService.markOnline([userId]);
      return;
    }
    set?.delete(conn);
    if (set?.size === 0) {
      this.agentSockets.delete(userId);
      void this.deps.agentsService.markOffline(userId);
    }
  }
}
