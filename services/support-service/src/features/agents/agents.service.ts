import { ForbiddenError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import { supportKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import type { App } from '../../middleware/http.js';
import type { Actor } from '../audit/index.js';
import type { Team } from '../topics/index.js';
import type { AgentInput, AgentView, CannedReplyInput, CannedReplyView } from './agents.types.js';

/** Presence TTL; open agent sockets refresh it every 45 s. */
export const PRESENCE_TTL_SECONDS = 90;

type Deps = Pick<Cradle, 'agentsRepository' | 'auditService' | 'runInTransaction' | 'redis' | 'authDirectory' | 'logger'>;

export class AgentsService {
  constructor(private readonly deps: Deps) {}

  async list(): Promise<AgentView[]> {
    const agents = await this.deps.agentsRepository.list();
    const online = await this.onlineSet(agents.map((a) => a.userId));
    return agents.map((a) => ({ ...a, online: online.has(a.userId) }));
  }

  /** The caller's agent profile; 403 when they are not an active agent. */
  async me(userId: string): Promise<AgentView> {
    const agent = await this.deps.agentsRepository.find(userId);
    if (agent === null || !agent.isActive) throw new ForbiddenError('You are not an active support agent');
    return { ...agent, online: (await this.onlineSet([userId])).has(userId) };
  }

  /** Display name for system messages ("Swathi joined"); null when not an agent. */
  async displayName(userId: string): Promise<string | null> {
    return (await this.deps.agentsRepository.find(userId))?.displayName ?? null;
  }

  async save(actor: Actor, userId: string, input: AgentInput): Promise<AgentView> {
    const contact = await this.deps.authDirectory.contact(userId);
    if (contact === null || contact.userType !== 'INTERNAL')
      throw new ValidationError([{ path: 'params.userId', message: 'must be an existing staff (INTERNAL) user' }]);
    return this.deps.runInTransaction(async (tx) => {
      const agent = await this.deps.agentsRepository.upsert(tx, userId, input);
      await this.deps.auditService.record(tx, actor, { action: 'agent.save', targetType: 'agent', targetId: userId, after: input });
      return agent;
    });
  }

  async setAccepting(userId: string, accepting: boolean): Promise<AgentView> {
    const agent = await this.deps.agentsRepository.setAccepting(userId, accepting);
    if (agent === null) throw new ForbiddenError('You are not an active support agent');
    return agent;
  }

  // ── Assignment (called by tickets inside ITS transaction) ──

  /** Online, accepting agents with capacity (read BEFORE the transaction; Redis presence). */
  async onlineCandidates(team: Team, app: App): Promise<string[]> {
    const ids = await this.deps.agentsRepository.candidates(team, app);
    const online = await this.onlineSet(ids);
    return ids.filter((id) => online.has(id));
  }

  claimLeastLoaded(tx: Tx, candidateIds: readonly string[]) {
    return this.deps.agentsRepository.claimLeastLoaded(tx, candidateIds);
  }

  adjustLoad(tx: Tx, userId: string | null, delta: number): Promise<void> {
    return userId === null ? Promise.resolve() : this.deps.agentsRepository.adjustLoad(tx, userId, delta);
  }

  // ── Presence (chat sockets) ──

  async markOnline(userIds: Iterable<string>): Promise<void> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return;
    try {
      const pipeline = this.deps.redis.pipeline();
      for (const id of ids) pipeline.set(supportKeys.agentOnline(id), '1', 'EX', PRESENCE_TTL_SECONDS);
      await pipeline.exec();
    } catch (err) {
      this.deps.logger.warn({ err }, 'agent presence write failed');
    }
  }

  async markOffline(userId: string): Promise<void> {
    await this.deps.redis.del(supportKeys.agentOnline(userId)).catch(() => 0);
  }

  private async onlineSet(userIds: readonly string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    try {
      const flags = await this.deps.redis.mget(...userIds.map((id) => supportKeys.agentOnline(id)));
      return new Set(userIds.filter((_, i) => flags[i] !== null));
    } catch {
      return new Set();
    }
  }

  // ── Canned replies ──

  cannedReplies(app?: App, topicCode?: string): Promise<CannedReplyView[]> {
    return this.deps.agentsRepository.cannedReplies(app, topicCode);
  }

  async createCanned(actor: Actor, input: CannedReplyInput): Promise<CannedReplyView> {
    return this.deps.runInTransaction(async (tx) => {
      const row = await this.deps.agentsRepository.createCanned(tx, input, actor.userId ?? '');
      await this.deps.auditService.record(tx, actor, { action: 'canned.create', targetType: 'canned_reply', targetId: row.id, after: { title: row.title } });
      return row;
    });
  }

  async updateCanned(actor: Actor, id: string, input: Partial<CannedReplyInput>): Promise<CannedReplyView> {
    return this.deps.runInTransaction(async (tx) => {
      const row = await this.deps.agentsRepository.updateCanned(tx, id, input);
      if (row === null) throw new NotFoundError('Canned reply');
      await this.deps.auditService.record(tx, actor, { action: 'canned.update', targetType: 'canned_reply', targetId: id, after: { title: row.title, isActive: row.isActive } });
      return row;
    });
  }
}
