import { ConflictError, NotFoundError } from '@farmx/common/errors';
import { advisoryXactLock } from '@farmx/database';
import { supportKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import type { App } from '../../middleware/http.js';
import type { Actor } from '../audit/index.js';
import type { LegalDraftInput, LegalKind, LegalView } from './legal.types.js';

type Deps = Pick<Cradle, 'legalRepository' | 'auditService' | 'runInTransaction' | 'cache' | 'cacheGen'>;

/** Versioned legal pages: drafts are edited freely; publish swaps the live version atomically. */
export class LegalService {
  constructor(private readonly deps: Deps) {}

  async published(kind: LegalKind, app: App): Promise<LegalView> {
    const gen = await this.deps.cacheGen.content();
    const doc = await this.deps.cache.getOrSet(supportKeys.content(gen, `legal.${kind}.${app}`), 600, async () =>
      (await this.deps.legalRepository.published(kind, app)) ?? undefined,
    );
    if (doc === undefined) throw new NotFoundError('Document');
    return doc;
  }

  list(kind?: LegalKind, app?: App | null): Promise<LegalView[]> {
    return this.deps.legalRepository.list(kind, app);
  }

  async createDraft(actor: Actor, input: LegalDraftInput): Promise<LegalView> {
    return this.deps.runInTransaction(async (tx) => {
      await advisoryXactLock(tx, `legal:${input.kind}:${input.app ?? 'ALL'}`);
      const version = await this.deps.legalRepository.nextVersion(tx, input.kind, input.app ?? null);
      const doc = await this.deps.legalRepository.create(tx, input, version, actor.userId ?? '');
      await this.deps.auditService.record(tx, actor, {
        action: 'legal.draft',
        targetType: 'legal',
        targetId: doc.id,
        after: { kind: doc.kind, app: doc.app, version },
      });
      return doc;
    });
  }

  async updateDraft(actor: Actor, id: string, input: Partial<LegalDraftInput>): Promise<LegalView> {
    return this.deps.runInTransaction(async (tx) => {
      const doc = await this.deps.legalRepository.find(tx, id);
      if (doc === null) throw new NotFoundError('Document');
      if (doc.status !== 'DRAFT') throw new ConflictError('Only drafts can be edited; create a new version');
      const updated = await this.deps.legalRepository.updateDraft(tx, id, input);
      await this.deps.auditService.record(tx, actor, {
        action: 'legal.edit',
        targetType: 'legal',
        targetId: id,
        after: { version: doc.version },
      });
      return updated;
    });
  }

  async publish(actor: Actor, id: string, reason: string): Promise<LegalView> {
    const doc = await this.deps.runInTransaction(async (tx) => {
      const draft = await this.deps.legalRepository.find(tx, id);
      if (draft === null) throw new NotFoundError('Document');
      if (draft.status !== 'DRAFT') throw new ConflictError(`Version ${String(draft.version)} is ${draft.status}`);
      await advisoryXactLock(tx, `legal:${draft.kind}:${draft.app ?? 'ALL'}`);
      const published = await this.deps.legalRepository.publish(tx, draft, actor.userId ?? '');
      await this.deps.auditService.record(tx, actor, {
        action: 'legal.publish',
        targetType: 'legal',
        targetId: id,
        after: { kind: draft.kind, app: draft.app, version: draft.version },
        reason,
      });
      return published;
    });
    await this.deps.cacheGen.bumpContent();
    return doc;
  }
}
