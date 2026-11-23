import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import { supportKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import { Snapshot } from '../../adapters/cache-gen.js';
import type { App } from '../../middleware/http.js';
import { omit } from '../../middleware/http.js';
import type { Actor } from '../audit/index.js';
import {
  type Priority,
  type PriorityDecision,
  type PriorityRule,
  type TicketFacts,
  decidePriority,
} from './topics.rules.js';
import type { BusinessCalendar, SlaPolicySnapshot } from './topics.sla.js';
import {
  DEFAULT_SLA,
  type RuleInput,
  type RuleView,
  type SlaPolicyInput,
  type SlaPolicyView,
  type TopicInput,
  type TopicView,
} from './topics.types.js';

interface TopicsSnapshot {
  topics: TopicView[];
  rules: RuleView[];
  policies: SlaPolicyView[];
}

const PRIORITY_LIST: readonly Priority[] = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];
const ALL_APPS: readonly App[] = ['CUSTOMER', 'VENDOR', 'LOGISTICS', 'WAREHOUSE'];

type Deps = Pick<
  Cradle,
  | 'topicsRepository'
  | 'settingsService'
  | 'auditService'
  | 'runInTransaction'
  | 'cache'
  | 'cacheGen'
>;

/** Topics, dynamic priority rules and SLA policies: cached snapshot + admin CRUD. */
export class TopicsService {
  private readonly snapshot: Snapshot<TopicsSnapshot>;

  constructor(private readonly deps: Deps) {
    this.snapshot = new Snapshot({
      gen: () => deps.cacheGen.config(),
      load: (gen) =>
        deps.cache.getOrSet(`${supportKeys.config(gen)}:topics`, 600, async () => {
          const [topics, rules, policies] = await Promise.all([
            deps.topicsRepository.topics(),
            deps.topicsRepository.rules(),
            deps.topicsRepository.policies(),
          ]);
          return { topics, rules, policies };
        }),
    });
  }

  /** An ACTIVE topic of the app, or 422 on `topicCode`. */
  async activeTopic(app: App, code: string): Promise<TopicView> {
    const topic = (await this.snapshot.get()).topics.find(
      (t) => t.app === app && t.code === code && t.isActive,
    );
    if (topic === undefined)
      throw new ValidationError([
        { path: 'body.topicCode', message: 'is not an active topic of your app' },
      ]);
    return topic;
  }

  async topicById(id: string): Promise<TopicView | null> {
    return (await this.snapshot.get()).topics.find((t) => t.id === id) ?? null;
  }

  /** Dynamic priority: first matching active rule, else the topic default. */
  async decide(facts: TicketFacts, topic: TopicView): Promise<PriorityDecision> {
    const rules: PriorityRule[] = (await this.snapshot.get()).rules.filter((r) => r.isActive);
    return decidePriority(rules, facts, topic);
  }

  /** SLA policy + calendar for (app, priority). No saved policy → wall-clock defaults. */
  async policy(
    app: App,
    priority: Priority,
  ): Promise<{ policy: SlaPolicySnapshot; calendar: BusinessCalendar | null }> {
    const saved = (await this.snapshot.get()).policies.find(
      (p) => p.app === app && p.priority === priority,
    );
    const policy: SlaPolicySnapshot =
      saved === undefined
        ? { calendarId: null, businessHoursOnly: false, ...DEFAULT_SLA[priority] }
        : {
            calendarId: saved.calendarId,
            firstResponseMins: saved.firstResponseMins,
            resolveMins: saved.resolveMins,
            businessHoursOnly: saved.businessHoursOnly,
          };
    return { policy, calendar: await this.calendarOf(policy) };
  }

  /** The calendar of a stored policy snapshot (null = 24×7). */
  calendarOf(policy: SlaPolicySnapshot): Promise<BusinessCalendar | null> {
    return this.deps.settingsService.calendar(policy.businessHoursOnly ? policy.calendarId : null);
  }

  /** Help & Support home: contacts, chat switch, topics and Common Issues of one app. */
  async publicConfig(app: App) {
    const [{ topics }, settings] = await Promise.all([
      this.snapshot.get(),
      this.deps.settingsService.current(),
    ]);
    const active = topics
      .filter((t) => t.app === app && t.isActive)
      .map((t) => ({
        code: t.code,
        label: t.label,
        description: t.description,
        icon: t.icon,
        requiresOrder: t.requiresOrder,
        allowsEvidence: t.allowsEvidence,
        isCommonIssue: t.isCommonIssue,
      }));
    return {
      app,
      contacts: settings.contacts,
      chat: { enabled: settings.chat.enabled },
      limits: { maxAttachmentsPerMessage: settings.limits.maxAttachmentsPerMessage },
      topics: active,
      commonIssues: active.filter((t) => t.isCommonIssue),
    };
  }

  // ── Admin ──

  async listTopics(app?: App): Promise<TopicView[]> {
    const all = await this.deps.topicsRepository.topics();
    return app === undefined ? all : all.filter((t) => t.app === app);
  }

  async createTopic(actor: Actor, input: TopicInput): Promise<TopicView> {
    const created = await this.deps.runInTransaction(async (tx) => {
      const topic = await this.deps.topicsRepository
        .createTopic(tx, input)
        .catch((err: unknown) => {
          throw isConflict(err)
            ? new ConflictError(`Topic ${input.code} already exists for ${input.app}`)
            : err;
        });
      await this.audit(tx, actor, 'topic.create', 'topic', topic.id, topic, input.reason);
      return topic;
    });
    await this.changed();
    return created;
  }

  async updateTopic(actor: Actor, id: string, input: Partial<TopicInput>): Promise<TopicView> {
    const updated = await this.deps.runInTransaction(async (tx) => {
      const topic = await this.deps.topicsRepository.updateTopic(tx, id, input);
      if (topic === null) throw new NotFoundError('Topic');
      await this.audit(tx, actor, 'topic.update', 'topic', id, topic, input.reason);
      return topic;
    });
    await this.changed();
    return updated;
  }

  listRules(): Promise<RuleView[]> {
    return this.deps.topicsRepository.rules();
  }

  async createRule(actor: Actor, input: RuleInput): Promise<RuleView> {
    const created = await this.deps.runInTransaction(async (tx) => {
      const rule = await this.deps.topicsRepository.createRule(tx, input);
      await this.audit(tx, actor, 'rule.create', 'rule', rule.id, rule, input.reason);
      return rule;
    });
    await this.changed();
    return created;
  }

  async updateRule(actor: Actor, id: string, input: Partial<RuleInput>): Promise<RuleView> {
    const updated = await this.deps.runInTransaction(async (tx) => {
      const rule = await this.deps.topicsRepository.updateRule(tx, id, input);
      if (rule === null) throw new NotFoundError('Priority rule');
      await this.audit(tx, actor, 'rule.update', 'rule', id, rule, input.reason);
      return rule;
    });
    await this.changed();
    return updated;
  }

  /** Every (app, priority) cell, saved or default. */
  async listPolicies(): Promise<SlaPolicyView[]> {
    const saved = await this.deps.topicsRepository.policies();
    return ALL_APPS.flatMap((app) =>
      PRIORITY_LIST.map(
        (priority) =>
          saved.find((p) => p.app === app && p.priority === priority) ?? {
            app,
            priority,
            calendarId: null,
            businessHoursOnly: false,
            updatedAt: null,
            ...DEFAULT_SLA[priority],
          },
      ),
    );
  }

  async savePolicy(
    actor: Actor,
    app: App,
    priority: Priority,
    input: SlaPolicyInput,
  ): Promise<SlaPolicyView> {
    if (input.businessHoursOnly && input.calendarId === null)
      throw new ValidationError([
        { path: 'body.calendarId', message: 'is required when businessHoursOnly is true' },
      ]);
    if (
      input.calendarId !== null &&
      (await this.deps.settingsService.calendar(input.calendarId)) === null
    )
      throw new ValidationError([
        { path: 'body.calendarId', message: 'is not an active calendar' },
      ]);
    await this.deps.runInTransaction(async (tx) => {
      await this.deps.topicsRepository.upsertPolicy(tx, app, priority, input);
      const { reason, ...after } = input;
      await this.audit(tx, actor, 'sla.update', 'sla', `${app}:${priority}`, after, reason);
    });
    await this.changed();
    const policy = omit(input, ['reason']); // audit only
    return { app, priority, ...policy, updatedAt: new Date() };
  }

  private audit(
    tx: Tx,
    actor: Actor,
    action: string,
    targetType: 'topic' | 'rule' | 'sla',
    targetId: string,
    after: object,
    reason?: string,
  ) {
    return this.deps.auditService.record(tx, actor, {
      action,
      targetType,
      targetId,
      after,
      reason: reason ?? null,
    });
  }

  private async changed(): Promise<void> {
    await this.deps.cacheGen.bumpConfig();
    this.snapshot.reset();
  }
}

const isConflict = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  'statusCode' in err &&
  (err as { statusCode: number }).statusCode === 409;
