import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { App } from '../../middleware/http.js';
import { omit } from '../../middleware/http.js';
import type { Priority, RuleConditions } from './topics.rules.js';
import type {
  RuleInput,
  RuleView,
  SlaPolicyInput,
  SlaPolicyView,
  TopicInput,
  TopicView,
} from './topics.types.js';

const TOPIC = {
  id: true,
  app: true,
  code: true,
  label: true,
  description: true,
  icon: true,
  sortOrder: true,
  defaultPriority: true,
  team: true,
  requiresOrder: true,
  allowsEvidence: true,
  isCommonIssue: true,
  isActive: true,
  updatedAt: true,
} as const;

const RULE = {
  id: true,
  name: true,
  app: true,
  topicCode: true,
  conditions: true,
  priority: true,
  reasonLabel: true,
  team: true,
  sortOrder: true,
  isActive: true,
  updatedAt: true,
} as const;

const toRule = (r: Prisma.SupportPriorityRuleGetPayload<{ select: typeof RULE }>): RuleView => ({
  ...r,
  conditions: r.conditions as RuleConditions,
});

/** Only place that touches `support_topics`, `support_priority_rules`, `support_sla_policies`. */
export class TopicsRepository {
  constructor(private readonly deps: Pick<Cradle, 'db'>) {}

  topics(): Promise<TopicView[]> {
    return withPrismaErrors(() =>
      this.deps.db.supportTopic.findMany({
        orderBy: [{ app: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }],
        select: TOPIC,
      }),
    );
  }

  async rules(): Promise<RuleView[]> {
    const rows = await withPrismaErrors(() =>
      this.deps.db.supportPriorityRule.findMany({
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: RULE,
      }),
    );
    return rows.map(toRule);
  }

  async policies(): Promise<SlaPolicyView[]> {
    const rows = await withPrismaErrors(() => this.deps.db.supportSlaPolicy.findMany());
    return rows.map((p) => ({
      app: p.app,
      priority: p.priority,
      calendarId: p.calendarId,
      firstResponseMins: p.firstResponseMins,
      resolveMins: p.resolveMins,
      businessHoursOnly: p.businessHoursOnly,
      updatedAt: p.updatedAt,
    }));
  }

  createTopic(tx: Tx, input: TopicInput): Promise<TopicView> {
    const data = omit(input, ['reason']); // audit only
    return withPrismaErrors(() => tx.supportTopic.create({ data, select: TOPIC }));
  }

  async updateTopic(tx: Tx, id: string, input: Partial<TopicInput>): Promise<TopicView | null> {
    const data = omit(input, ['reason', 'app', 'code']); // audit only / immutable
    const res = await withPrismaErrors(() => tx.supportTopic.updateMany({ where: { id }, data }));
    return res.count === 0 ? null : tx.supportTopic.findUnique({ where: { id }, select: TOPIC });
  }

  async createRule(tx: Tx, input: RuleInput): Promise<RuleView> {
    const { conditions, ...data } = omit(input, ['reason']); // reason: audit only
    return toRule(
      await withPrismaErrors(() =>
        tx.supportPriorityRule.create({
          data: { ...data, conditions: conditions as Prisma.InputJsonValue },
          select: RULE,
        }),
      ),
    );
  }

  async updateRule(tx: Tx, id: string, input: Partial<RuleInput>): Promise<RuleView | null> {
    const { conditions, ...data } = omit(input, ['reason']); // reason: audit only
    const res = await withPrismaErrors(() =>
      tx.supportPriorityRule.updateMany({
        where: { id },
        data: {
          ...data,
          ...(conditions === undefined ? {} : { conditions: conditions as Prisma.InputJsonValue }),
        },
      }),
    );
    if (res.count === 0) return null;
    const row = await tx.supportPriorityRule.findUnique({ where: { id }, select: RULE });
    return row === null ? null : toRule(row);
  }

  async upsertPolicy(tx: Tx, app: App, priority: Priority, input: SlaPolicyInput): Promise<void> {
    const data = {
      calendarId: input.calendarId,
      firstResponseMins: input.firstResponseMins,
      resolveMins: input.resolveMins,
      businessHoursOnly: input.businessHoursOnly,
    };
    await withPrismaErrors(() =>
      tx.supportSlaPolicy.upsert({
        where: { app_priority: { app, priority } },
        create: { app, priority, ...data },
        update: data,
      }),
    );
  }
}
