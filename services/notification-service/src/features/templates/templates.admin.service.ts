import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from '../../adapters/uuid.js';
import type { Actor } from '../audit/index.js';
import { placeholdersOf } from './templates.renderer.js';
import type { RenderedChannel } from './templates.service.js';
import type {
  Channel,
  TemplateInput,
  TemplateRecord,
  TemplateVars,
  VariableDef,
} from './templates.types.js';

type Deps = Pick<
  Cradle,
  'templatesRepository' | 'templatesService' | 'auditService' | 'runInTransaction'
>;

export interface CreateTemplateInput extends TemplateInput {
  key: string;
  channel: Channel;
  locale: string;
  variables: VariableDef[];
  reason: string;
}

export interface NewVersionInput extends TemplateInput {
  /** Default true. false = draft (preview it, then activate). */
  activate?: boolean;
  reason: string;
}

/**
 * Template management (staff). A template family is (key, channel, locale); editing creates a new
 * VERSION, and exactly one version is active. A new version must keep the family's variables
 * (names and types): events and admin sends pass exactly those values, so changing them would
 * break delivery. A different set of variables is a new key.
 */
export class TemplatesAdminService {
  constructor(private readonly deps: Deps) {}

  list(filter: { key?: string; channel?: Channel; activeOnly?: boolean }) {
    return this.deps.templatesRepository.list(filter);
  }

  async get(id: string): Promise<TemplateRecord> {
    const t = await this.deps.templatesRepository.findById(id);
    if (t === null) throw new NotFoundError('Template not found');
    return t;
  }

  /** A new family (version 1, active). 409 when the family exists: add a version instead. */
  async create(actor: Actor, input: CreateTemplateInput): Promise<TemplateRecord> {
    checkPlaceholders(input, input.variables);
    const { templatesRepository: repo, auditService, runInTransaction } = this.deps;
    const created = await runInTransaction(async (tx) => {
      if ((await repo.lockFamily(tx, input.key, input.channel, input.locale)) > 0)
        throw new ConflictError('This template already exists; add a new version instead', {
          details: { reason: 'TEMPLATE_EXISTS' },
        });
      const t = await repo.insert(tx, {
        id: uuidv7(),
        key: input.key,
        channel: input.channel,
        locale: input.locale,
        version: 1,
        title: input.title ?? null,
        body: input.body,
        htmlBody: input.htmlBody ?? null,
        variables: input.variables,
        description: input.description ?? null,
        isActive: true,
        createdBy: actor.userId,
      });
      await auditService.record(tx, actor, {
        action: 'template.create',
        targetType: 'template',
        targetId: t.id,
        after: summary(t),
        reason: input.reason,
      });
      return t;
    });
    this.deps.templatesService.invalidate(created.key);
    return created;
  }

  /** A new version of `id`'s family (same variables), active unless `activate: false`. */
  async newVersion(actor: Actor, id: string, input: NewVersionInput): Promise<TemplateRecord> {
    const base = await this.get(id);
    checkPlaceholders(input, base.variables);
    const { templatesRepository: repo, auditService, runInTransaction } = this.deps;
    const created = await runInTransaction(async (tx) => {
      const latest = await repo.lockFamily(tx, base.key, base.channel, base.locale);
      const t = await repo.insert(tx, {
        id: uuidv7(),
        key: base.key,
        channel: base.channel,
        locale: base.locale,
        version: latest + 1,
        title: input.title === undefined ? base.title : input.title,
        body: input.body,
        htmlBody: input.htmlBody === undefined ? base.htmlBody : input.htmlBody,
        variables: base.variables,
        description: input.description === undefined ? base.description : input.description,
        isActive: false,
        createdBy: actor.userId,
      });
      if (input.activate !== false) await repo.activate(tx, t);
      await auditService.record(tx, actor, {
        action: 'template.version',
        targetType: 'template',
        targetId: t.id,
        before: summary(base),
        after: { ...summary(t), isActive: input.activate !== false },
        reason: input.reason,
      });
      return { ...t, isActive: input.activate !== false };
    });
    this.deps.templatesService.invalidate(created.key);
    return created;
  }

  /** Rolls a family forward or back to version `id`. */
  async activate(actor: Actor, id: string, reason: string): Promise<TemplateRecord> {
    const { templatesRepository: repo, auditService, runInTransaction } = this.deps;
    const t = await runInTransaction(async (tx) => {
      const found = await repo.findById(id, tx);
      if (found === null) throw new NotFoundError('Template not found');
      await repo.lockFamily(tx, found.key, found.channel, found.locale);
      await repo.activate(tx, found);
      await auditService.record(tx, actor, {
        action: 'template.activate',
        targetType: 'template',
        targetId: found.id,
        after: summary(found),
        reason,
      });
      return { ...found, isActive: true };
    });
    this.deps.templatesService.invalidate(t.key);
    return t;
  }

  /** Renders one version with sample values (no side effects). 422 on bad values. */
  async preview(id: string, vars: TemplateVars): Promise<RenderedChannel> {
    return this.deps.templatesService.preview(await this.get(id), vars);
  }
}

/** Every `{{name}}` in title / body / html must be a declared variable. */
const checkPlaceholders = (input: TemplateInput, defs: readonly VariableDef[]): void => {
  const declared = new Set(defs.map((d) => d.name));
  const issues = (
    [
      ['title', input.title],
      ['body', input.body],
      ['htmlBody', input.htmlBody],
    ] as const
  ).flatMap(([path, text]) =>
    placeholdersOf(text ?? '')
      .filter((name) => !declared.has(name))
      .map((name) => ({ path, message: `uses {{${name}}}, which is not a declared variable` })),
  );
  if (issues.length > 0) throw new ValidationError(issues, 'Unknown template placeholders');
};

const summary = (t: TemplateRecord) => ({
  key: t.key,
  channel: t.channel,
  locale: t.locale,
  version: t.version,
});
