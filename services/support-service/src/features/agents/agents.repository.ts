import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { App } from '../../middleware/http.js';
import type { Team } from '../topics/index.js';
import type { AgentInput, AgentView, CannedReplyInput, CannedReplyView } from './agents.types.js';

const AGENT = {
  userId: true,
  displayName: true,
  teams: true,
  apps: true,
  maxConcurrent: true,
  acceptingChats: true,
  openCount: true,
  isActive: true,
  updatedAt: true,
} as const;
const CANNED = {
  id: true,
  app: true,
  topicCode: true,
  title: true,
  body: true,
  isActive: true,
  updatedAt: true,
} as const;

/** Only place that touches `support_agents` and `support_canned_replies`. */
export class AgentsRepository {
  constructor(private readonly deps: Pick<Cradle, 'db'>) {}

  list(): Promise<AgentView[]> {
    return withPrismaErrors(() =>
      this.deps.db.supportAgent.findMany({ orderBy: { displayName: 'asc' }, select: AGENT }),
    );
  }

  find(userId: string): Promise<AgentView | null> {
    return withPrismaErrors(() =>
      this.deps.db.supportAgent.findUnique({ where: { userId }, select: AGENT }),
    );
  }

  upsert(tx: Tx, userId: string, input: AgentInput): Promise<AgentView> {
    return withPrismaErrors(() =>
      tx.supportAgent.upsert({
        where: { userId },
        create: { userId, ...input },
        update: input,
        select: AGENT,
      }),
    );
  }

  async setAccepting(userId: string, acceptingChats: boolean): Promise<AgentView | null> {
    const res = await this.deps.db.supportAgent.updateMany({
      where: { userId, isActive: true },
      data: { acceptingChats },
    });
    return res.count === 0 ? null : this.find(userId);
  }

  /** Accepting agents of a team + app with spare capacity (no lock; presence filtered after). */
  async candidates(team: Team, app: App): Promise<string[]> {
    const rows = await this.deps.db.$queryRaw<{ userId: string }[]>`
      SELECT "userId" FROM "support_agents"
       WHERE "isActive" AND "acceptingChats" AND "openCount" < "maxConcurrent"
         AND ${team}::"SupportTeam" = ANY("teams") AND ${app}::"SupportApp" = ANY("apps")
       ORDER BY "openCount", "updatedAt" LIMIT 50`;
    return rows.map((r) => r.userId);
  }

  /**
   * Least-loaded of `userIds`, row-locked with SKIP LOCKED: two tickets created at the same moment
   * never pick the same agent row concurrently and never overfill it. Increments the load.
   */
  async claimLeastLoaded(
    tx: Tx,
    userIds: readonly string[],
  ): Promise<{ userId: string; displayName: string } | null> {
    if (userIds.length === 0) return null;
    const rows = await tx.$queryRaw<{ userId: string; displayName: string }[]>`
      SELECT "userId", "displayName" FROM "support_agents"
       WHERE "userId" = ANY(${userIds}::uuid[]) AND "isActive" AND "acceptingChats"
         AND "openCount" < "maxConcurrent"
       ORDER BY "openCount", "updatedAt" LIMIT 1
       FOR UPDATE SKIP LOCKED`;
    const picked = rows[0];
    if (picked === undefined) return null;
    await this.adjustLoad(tx, picked.userId, 1);
    return picked;
  }

  async adjustLoad(tx: Tx, userId: string, delta: number): Promise<void> {
    if (delta === 0) return;
    await tx.$executeRaw`
      UPDATE "support_agents" SET "openCount" = GREATEST("openCount" + ${delta}, 0), "updatedAt" = now()
       WHERE "userId" = ${userId}::uuid`;
  }

  cannedReplies(app?: App, topicCode?: string): Promise<CannedReplyView[]> {
    return withPrismaErrors(() =>
      this.deps.db.supportCannedReply.findMany({
        where: {
          ...(app === undefined ? {} : { OR: [{ app }, { app: null }] }),
          ...(topicCode === undefined
            ? {}
            : { AND: [{ OR: [{ topicCode }, { topicCode: null }] }] }),
        },
        orderBy: [{ isActive: 'desc' }, { title: 'asc' }],
        select: CANNED,
      }),
    );
  }

  createCanned(tx: Tx, input: CannedReplyInput, createdBy: string): Promise<CannedReplyView> {
    return withPrismaErrors(() =>
      tx.supportCannedReply.create({ data: { ...input, createdBy }, select: CANNED }),
    );
  }

  async updateCanned(
    tx: Tx,
    id: string,
    input: Partial<CannedReplyInput>,
  ): Promise<CannedReplyView | null> {
    const res = await withPrismaErrors(() =>
      tx.supportCannedReply.updateMany({ where: { id }, data: input }),
    );
    return res.count === 0
      ? null
      : tx.supportCannedReply.findUnique({ where: { id }, select: CANNED });
  }
}
