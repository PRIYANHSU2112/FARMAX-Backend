import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import type { Tx } from '@farmx/database';
import { FARM_EVENTS } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from '../../adapters/outbox.repository.js';
import type { Actor } from '../audit/index.js';
import { type ItemData, columnsOf } from './content.repository.js';
import {
  type GateIssue,
  authorsOf,
  canTransition,
  contentHash,
  defaultExpiry,
  derive,
  isClinical,
  isMediaUrl,
  maxExpiry,
  publishBlockers,
  roundArea,
  signOffFresh,
  slugify,
} from './content.rules.js';
import type {
  AdminListQuery,
  ContentFields,
  ContentRow,
  ContentStatus,
  CorrectionChanges,
  CreateInput,
  DraftPatch,
  PublishInput,
  ReviewerRow,
  RevisionRow,
  StatusEventRow,
  TopicRow,
} from './content.types.js';

type Deps = Pick<
  Cradle,
  | 'contentRepository'
  | 'contentService'
  | 'auditService'
  | 'outbox'
  | 'runInTransaction'
  | 'config'
  | 'logger'
>;

const FIELD_KEYS = [
  'title',
  'summary',
  'heroImageUrl',
  'heroMediaId',
  'blocks',
  'sources',
  'ctas',
  'tags',
  'relatedIds',
  'asset',
  'severity',
  'placeLabel',
  'area',
  'productionTypes',
  'territoryCodes',
] as const satisfies readonly (keyof ContentFields)[];

const EMPTY_FIELDS: Omit<ContentFields, 'title' | 'summary'> = {
  heroImageUrl: null,
  heroMediaId: null,
  blocks: [],
  sources: [],
  ctas: [],
  tags: [],
  relatedIds: [],
  asset: null,
  severity: null,
  placeLabel: null,
  area: null,
  productionTypes: [],
  territoryCodes: [],
};

const fieldsOf = (row: ContentRow): ContentFields => {
  const out = {} as Record<string, unknown>;
  for (const k of FIELD_KEYS) out[k] = row[k];
  return out as unknown as ContentFields;
};

/** Only the editable keys that were sent (undefined = untouched). */
const pickFields = (input: Partial<ContentFields>): Partial<ContentFields> => {
  const out: Record<string, unknown> = {};
  for (const k of FIELD_KEYS) if (input[k] !== undefined) out[k] = input[k];
  return out;
};

const toIso = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as string | Date).toISOString();

/** One change of an item, applied under its version (and status) guard. */
interface Change {
  from: readonly ContentStatus[];
  to?: ContentStatus;
  data: ItemData;
  bumpContent?: boolean;
  action: string;
  reason?: string | null;
  after?: (tx: Tx) => Promise<void>;
  audit?: { before?: object; after?: object };
}

export interface AdminDetail {
  item: ContentRow;
  revisions: RevisionRow[];
  history: StatusEventRow[];
  /** Why it cannot be published right now (empty = ready). */
  blockers: GateIssue[];
}

/**
 * Authoring workflow with separation of duties:
 *   author (content.manage) → vet sign-off (content.review) → a DIFFERENT approver (content.publish).
 * Changing what readers see always takes two people (corrections too); taking content DOWN
 * (expire now / retract / archive) is a single, reasoned, audited action.
 */
export class ContentAdminService {
  constructor(private readonly deps: Deps) {}

  // ── Read ──

  async list(query: AdminListQuery): Promise<Paginated<ContentRow>> {
    let topicId: string | null = null;
    if (query.topic !== undefined) {
      const topic = (await this.deps.contentRepository.listTopics(false)).find(
        (t) => t.code === query.topic,
      );
      if (topic === undefined) return { items: [], nextCursor: null, limit: query.limit };
      topicId = topic.id;
    }
    return this.deps.contentRepository.adminList(query, topicId);
  }

  async get(id: string): Promise<AdminDetail> {
    const item = await this.must(id);
    const [revisions, history, reviewerValid] = await Promise.all([
      this.deps.contentRepository.listRevisions(id),
      this.deps.contentRepository.history(id),
      this.reviewerValid(item),
    ]);
    const blockers = ['DRAFT', 'IN_REVIEW'].includes(item.status)
      ? publishBlockers(item, { now: new Date(), reviewerValid })
      : [];
    return { item, revisions, history, blockers };
  }

  async stats(id: string) {
    const item = await this.must(id);
    const votes = item.helpfulYes + item.helpfulNo;
    return {
      id: item.id,
      status: item.status,
      contentVersion: item.contentVersion,
      views: item.viewCount,
      saves: item.saveCount,
      shares: item.shareCount,
      helpfulYes: item.helpfulYes,
      helpfulNo: item.helpfulNo,
      helpfulRate: votes === 0 ? null : Math.round((item.helpfulYes / votes) * 1000) / 10,
      trendingScore: item.trendingScore,
      note: 'Counters are buffered and can lag up to 60 seconds.',
    };
  }

  // ── Authoring (content.manage) ──

  async create(actor: Actor, input: CreateInput): Promise<ContentRow> {
    const topic = await this.activeTopic(input.topicId);
    const fields = this.normalize({
      ...EMPTY_FIELDS,
      ...pickFields(input),
      title: input.title,
      summary: input.summary,
    });
    const id = uuidv7();
    const expiresAt =
      input.expiresAt != null
        ? new Date(input.expiresAt)
        : input.kind === 'ALERT'
          ? defaultExpiry(new Date())
          : null;
    const created = await this.deps.runInTransaction(async (tx) => {
      const row = await this.deps.contentRepository.create(tx, {
        id,
        slug: slugify(fields.title, id),
        kind: input.kind,
        topicId: topic.id,
        isFeatured: input.isFeatured ?? false,
        notify: input.notify ?? input.kind === 'ALERT',
        expiresAt,
        userId: actor.userId,
        columns: columnsFor(fields),
      });
      await this.deps.contentRepository.insertStatusEvent(
        tx,
        id,
        null,
        'DRAFT',
        actor.userId,
        null,
      );
      await this.deps.auditService.record(tx, actor, {
        action: 'content.create',
        targetType: 'content',
        targetId: id,
        after: { kind: input.kind, topic: topic.code, title: fields.title },
      });
      return row;
    });
    return created;
  }

  /** Edit a DRAFT (in review → reject it back to draft first, so the reviewed text is fixed). */
  async update(actor: Actor, id: string, ifMatch: number | undefined, patch: DraftPatch) {
    return this.change(actor, id, ifMatch, async (item) => {
      const topicId =
        patch.topicId === undefined ? item.topic.id : (await this.activeTopic(patch.topicId)).id;
      const fields = this.normalize({ ...fieldsOf(item), ...pickFields(patch) });
      return {
        from: ['DRAFT'],
        data: {
          ...columnsFor(fields),
          topicId,
          ...(patch.isFeatured === undefined ? {} : { isFeatured: patch.isFeatured }),
          ...(patch.notify === undefined ? {} : { notify: patch.notify }),
          ...(patch.expiresAt === undefined ? {} : { expiresAt: toIso(patch.expiresAt) }),
          slug: fields.title === item.title ? item.slug : slugify(fields.title, item.id),
          updatedByUserId: actor.userId,
        },
        action: 'content.update',
        audit: { after: { fields: Object.keys(patch) } },
      };
    });
  }

  async remove(actor: Actor, id: string, ifMatch: number | undefined): Promise<void> {
    const item = await this.must(id);
    this.checkVersion(item, ifMatch);
    if (item.status !== 'DRAFT') throw this.stateError(item, 'Only drafts can be deleted');
    await this.deps.runInTransaction(async (tx) => {
      if (!(await this.deps.contentRepository.softDelete(tx, id, item.version)))
        throw this.versionError(item);
      await this.deps.auditService.record(tx, actor, {
        action: 'content.delete',
        targetType: 'content',
        targetId: id,
        before: { title: item.title },
      });
    });
  }

  async submit(actor: Actor, id: string, ifMatch: number | undefined) {
    return this.change(actor, id, ifMatch, (item) => {
      this.assertNoBlockers(
        publishBlockers(item, { now: new Date(), skipSignOff: true, reviewerValid: true }),
      );
      return {
        from: ['DRAFT'],
        to: 'IN_REVIEW',
        data: { submittedByUserId: actor.userId, submittedAt: new Date() },
        action: 'content.submit',
      };
    });
  }

  // ── Clinical sign-off (content.review, verified reviewer) ──

  /** A verified vet vouches for the exact current text (bound by hash: any edit voids it). */
  async signOff(actor: Actor, id: string, ifMatch: number | undefined) {
    const reviewer = await this.verifiedReviewer(actor.userId);
    return this.change(actor, id, ifMatch, (item) => {
      this.assertNotAuthor(item, actor, 'The author cannot sign off their own content');
      if (isClinical(item.kind, item.topic) && item.sources.length === 0)
        this.assertNoBlockers([{ code: 'SOURCE_REQUIRED', message: 'Cite at least one source' }]);
      return {
        from: ['IN_REVIEW', 'PUBLISHED', 'EXPIRED'],
        data: {
          clinicalReviewerId: reviewer.id,
          clinicalSignedOffAt: new Date(),
          signedOffHash: contentHash(item),
        },
        action: 'content.sign_off',
        audit: { after: { reviewerId: reviewer.id, registrationNo: reviewer.registrationNo } },
      };
    });
  }

  // ── Approval (content.publish) ──

  async publish(actor: Actor, id: string, ifMatch: number | undefined, input: PublishInput) {
    return this.change(actor, id, ifMatch, async (item) => {
      this.assertNotAuthor(item, actor, 'The author cannot approve their own content');
      const now = new Date();
      const publishAt = input.publishAt === undefined ? null : new Date(input.publishAt);
      this.assertNoBlockers(
        publishBlockers(item, {
          now,
          ...(publishAt === null ? {} : { goLiveAt: publishAt }),
          reviewerValid: await this.reviewerValid(item),
        }),
      );
      const notify = input.notify ?? item.notify;
      if (publishAt !== null)
        return {
          from: ['IN_REVIEW'],
          to: 'SCHEDULED',
          data: { publishAt, notify, publishedByUserId: actor.userId },
          action: 'content.schedule',
          reason: input.reason ?? null,
          audit: { after: { publishAt: publishAt.toISOString(), notify } },
        };
      return {
        from: ['IN_REVIEW'],
        to: 'PUBLISHED',
        data: {
          publishedAt: now,
          publishAt: null,
          notify,
          publishedByUserId: actor.userId,
          ...(notify ? { notifiedAt: now } : {}),
        },
        bumpContent: item.publishedAt !== null,
        action: 'content.publish',
        reason: input.reason ?? null,
        after: notify ? (tx) => this.emitPublished(tx, item, actor.requestId) : undefined,
        audit: { after: { notify } },
      } satisfies Change;
    });
  }

  async reject(actor: Actor, id: string, ifMatch: number | undefined, reason: string) {
    return this.change(actor, id, ifMatch, () => ({
      from: ['IN_REVIEW', 'SCHEDULED'],
      to: 'DRAFT',
      data: { publishAt: null },
      action: 'content.reject',
      reason,
    }));
  }

  /** Keep an alert live longer (≤ 30 days from now) — needs a sign-off younger than 30 days. */
  async extend(
    actor: Actor,
    id: string,
    ifMatch: number | undefined,
    input: { expiresAt: string | Date; reason: string },
  ) {
    return this.change(actor, id, ifMatch, (item) => {
      const now = new Date();
      const expiresAt = new Date(input.expiresAt);
      if (item.kind !== 'ALERT')
        throw new ConflictError('Only alerts expire', { details: { reason: 'NOT_AN_ALERT' } });
      if (expiresAt > maxExpiry(now))
        this.assertNoBlockers([
          { code: 'EXPIRY_TOO_FAR', message: 'An alert may run at most 30 days from now' },
        ]);
      if (!signOffFresh(item.clinicalSignedOffAt, now))
        throw new ConflictError('Get a fresh clinical sign-off before extending this alert', {
          details: { reason: 'SIGNOFF_STALE' },
        });
      return {
        from: ['PUBLISHED', 'EXPIRED'],
        to: 'PUBLISHED',
        data: { expiresAt, expiredAt: null },
        bumpContent: true,
        action: 'content.extend',
        reason: input.reason,
        audit: {
          before: { expiresAt: item.expiresAt },
          after: { expiresAt: expiresAt.toISOString() },
        },
      };
    });
  }

  /** Emergency takedown #1: end a live item now (single actor; it only reduces exposure). */
  async expireNow(actor: Actor, id: string, ifMatch: number | undefined, reason: string) {
    return this.change(actor, id, ifMatch, () => ({
      from: ['PUBLISHED'],
      to: 'EXPIRED',
      data: { expiredAt: new Date() },
      bumpContent: true,
      action: 'content.expire',
      reason,
    }));
  }

  /** Emergency takedown #2: withdraw as WRONG (final). Readers see only the public note. */
  async retract(
    actor: Actor,
    id: string,
    ifMatch: number | undefined,
    input: { reason: string; publicNote: string },
  ) {
    return this.change(actor, id, ifMatch, (item) => ({
      from: ['PUBLISHED', 'EXPIRED'],
      to: 'RETRACTED',
      data: { retractedAt: new Date(), retractNote: input.publicNote, isFeatured: false },
      bumpContent: true,
      action: 'content.retract',
      reason: input.reason,
      after: (tx) =>
        this.deps.outbox.add(
          tx,
          FARM_EVENTS.contentRetracted,
          {
            ...this.eventBase(item, item.contentVersion + 1),
            retractNote: input.publicNote,
            wasNotified: item.notifiedAt !== null,
          },
          actor.requestId,
        ),
      audit: { after: { publicNote: input.publicNote } },
    }));
  }

  async archive(actor: Actor, id: string, ifMatch: number | undefined, reason: string) {
    return this.change(actor, id, ifMatch, (item) => ({
      from: ['DRAFT', 'IN_REVIEW', 'SCHEDULED', 'PUBLISHED', 'EXPIRED'],
      to: 'ARCHIVED',
      data: { isFeatured: false },
      bumpContent: ['PUBLISHED', 'EXPIRED'].includes(item.status),
      action: 'content.archive',
      reason,
    }));
  }

  async restore(actor: Actor, id: string, ifMatch: number | undefined, reason: string | null) {
    return this.change(actor, id, ifMatch, () => ({
      from: ['ARCHIVED'],
      to: 'DRAFT',
      data: { publishAt: null },
      action: 'content.restore',
      reason,
    }));
  }

  // ── Corrections (two people: requester ≠ approver; clinical → vet sign-off too) ──

  async requestCorrection(
    actor: Actor,
    id: string,
    input: { changes: CorrectionChanges; changeNote: string },
  ): Promise<RevisionRow> {
    const item = await this.must(id);
    if (!['PUBLISHED', 'EXPIRED'].includes(item.status))
      throw this.stateError(item, 'Only live or ended items take corrections; edit the draft');
    const sent = pickFields(input.changes);
    const merged = this.normalize({ ...fieldsOf(item), ...sent });
    this.assertNoBlockers(
      publishBlockers(
        { ...item, ...merged },
        { now: new Date(), skipSignOff: true, reviewerValid: true },
      ).filter((i) => !i.code.startsWith('EXPIRY')),
    );
    // Store the normalised values of only the fields that change.
    const stored = Object.fromEntries(
      Object.keys(sent).map((k) => [k, merged[k as keyof ContentFields]]),
    );
    return this.deps.runInTransaction(async (tx) => {
      const revision = await this.deps.contentRepository.createRevision(tx, {
        contentId: id,
        baseVersion: item.contentVersion,
        changes: stored,
        changeNote: input.changeNote,
        userId: actor.userId,
      });
      await this.deps.auditService.record(tx, actor, {
        action: 'content.correction.request',
        targetType: 'content',
        targetId: id,
        after: { revisionId: revision.id, fields: Object.keys(stored), note: input.changeNote },
      });
      return revision;
    });
  }

  async signOffCorrection(actor: Actor, id: string, revisionId: string): Promise<RevisionRow> {
    const reviewer = await this.verifiedReviewer(actor.userId);
    const revision = await this.mustRevision(id, revisionId);
    if (revision.requestedByUserId === actor.userId)
      throw this.sod('The requester cannot sign off their own correction');
    await this.deps.runInTransaction(async (tx) => {
      if (!(await this.deps.contentRepository.signOffRevision(tx, revisionId, reviewer.id)))
        throw new ConflictError('This correction was already decided');
      await this.deps.auditService.record(tx, actor, {
        action: 'content.correction.sign_off',
        targetType: 'content',
        targetId: id,
        after: { revisionId, reviewerId: reviewer.id, registrationNo: reviewer.registrationNo },
      });
    });
    return this.mustRevision(id, revisionId);
  }

  /** Apply an approved correction: new contentVersion, public "Updated" note, optional push. */
  async approveCorrection(
    actor: Actor,
    id: string,
    revisionId: string,
    notify: boolean,
  ): Promise<ContentRow> {
    const revision = await this.mustRevision(id, revisionId);
    if (revision.status !== 'PENDING')
      throw new ConflictError('This correction was already decided');
    if (revision.requestedByUserId === actor.userId)
      throw this.sod('The requester cannot approve their own correction');
    return this.change(actor, id, undefined, async (item) => {
      if (revision.baseVersion !== item.contentVersion)
        throw new ConflictError(
          'The item changed after this correction was written; reject it and re-request',
          { details: { reason: 'CORRECTION_STALE' } },
        );
      const merged = this.normalize({ ...fieldsOf(item), ...pickFields(revision.changes) });
      const signer = isClinical(item.kind, item.topic)
        ? await this.correctionSigner(revision)
        : null;
      const now = new Date();
      return {
        from: ['PUBLISHED', 'EXPIRED'],
        data: {
          ...columnsFor(merged),
          lastCorrectedAt: now,
          correctionNote: revision.changeNote,
          updatedByUserId: revision.requestedByUserId,
          ...(signer === null
            ? {}
            : {
                clinicalReviewerId: signer.id,
                clinicalSignedOffAt: new Date(revision.signedOffAt ?? now),
                signedOffHash: contentHash({ ...merged, kind: item.kind }),
              }),
          ...(notify ? { notifiedAt: now } : {}),
        },
        bumpContent: true,
        action: 'content.correction.approve',
        reason: revision.changeNote,
        after: async (tx) => {
          if (
            !(await this.deps.contentRepository.decideRevision(
              tx,
              revisionId,
              'APPLIED',
              actor.userId,
              null,
            ))
          )
            throw new ConflictError('This correction was already decided');
          if (notify)
            await this.deps.outbox.add(
              tx,
              FARM_EVENTS.contentCorrected,
              {
                ...this.eventBase({ ...item, ...merged }, item.contentVersion + 1),
                correctionNote: revision.changeNote,
              },
              actor.requestId,
            );
        },
        audit: {
          before: Object.fromEntries(
            Object.keys(revision.changes).map((k) => [k, item[k as keyof ContentFields]]),
          ),
          after: { revisionId, ...revision.changes },
        },
      };
    });
  }

  /** The verified vet who signed off a clinical correction (409 if none / no longer valid). */
  private async correctionSigner(revision: RevisionRow): Promise<ReviewerRow> {
    const signer =
      revision.signedOffById === null
        ? null
        : await this.deps.contentRepository.findReviewer(revision.signedOffById);
    if (signer === null || !reviewerUsable(signer, new Date()))
      throw new ConflictError('A verified vet must sign off this correction first', {
        details: { reason: 'SIGNOFF_REQUIRED' },
      });
    return signer;
  }

  async rejectCorrection(
    actor: Actor,
    id: string,
    revisionId: string,
    reason: string,
  ): Promise<RevisionRow> {
    await this.mustRevision(id, revisionId);
    await this.deps.runInTransaction(async (tx) => {
      if (
        !(await this.deps.contentRepository.decideRevision(
          tx,
          revisionId,
          'REJECTED',
          actor.userId,
          reason,
        ))
      )
        throw new ConflictError('This correction was already decided');
      await this.deps.auditService.record(tx, actor, {
        action: 'content.correction.reject',
        targetType: 'content',
        targetId: id,
        reason,
        after: { revisionId },
      });
    });
    return this.mustRevision(id, revisionId);
  }

  // ── System transitions (content-tick job; no actor) ──

  /** A due SCHEDULED item goes live (idempotent: the status guard lets one replica win). */
  async goLive(item: ContentRow): Promise<boolean> {
    const now = new Date();
    const done = await this.deps.runInTransaction(async (tx) => {
      const ok = await this.deps.contentRepository.update(
        tx,
        item.id,
        { version: item.version, status: 'SCHEDULED' },
        {
          status: 'PUBLISHED',
          publishedAt: now,
          ...(item.notify ? { notifiedAt: now } : {}),
        },
        item.publishedAt !== null,
      );
      if (!ok) return false;
      await this.deps.contentRepository.insertStatusEvent(
        tx,
        item.id,
        'SCHEDULED',
        'PUBLISHED',
        null,
        'publishAt reached',
      );
      if (item.notify) await this.emitPublished(tx, item, `content-tick:${item.id}`);
      return true;
    });
    return done;
  }

  /** A live alert past `expiresAt` ends (out of the feed; offline copies get MARK_ENDED). */
  async expireDue(item: ContentRow): Promise<boolean> {
    return this.deps.runInTransaction(async (tx) => {
      const ok = await this.deps.contentRepository.update(
        tx,
        item.id,
        { version: item.version, status: 'PUBLISHED' },
        { status: 'EXPIRED', expiredAt: new Date(), isFeatured: false },
        true,
      );
      if (!ok) return false;
      await this.deps.contentRepository.insertStatusEvent(
        tx,
        item.id,
        'PUBLISHED',
        'EXPIRED',
        null,
        'expiresAt reached',
      );
      return true;
    });
  }

  // ── Topics ──

  listTopics(): Promise<TopicRow[]> {
    return this.deps.contentRepository.listTopics(false);
  }

  async createTopic(
    actor: Actor,
    input: { code: string; name: string; clinical: boolean; sortOrder: number },
  ): Promise<TopicRow> {
    const topic = await this.deps.runInTransaction(async (tx) => {
      const row = await this.deps.contentRepository.createTopic(tx, input, actor.userId);
      await this.deps.auditService.record(tx, actor, {
        action: 'content.topic.create',
        targetType: 'content_topic',
        targetId: row.id,
        after: input,
      });
      return row;
    });
    await this.deps.contentService.invalidate();
    return topic;
  }

  async updateTopic(
    actor: Actor,
    id: string,
    ifMatch: number | undefined,
    patch: Partial<Pick<TopicRow, 'name' | 'clinical' | 'sortOrder' | 'isActive'>>,
  ): Promise<TopicRow> {
    const topic = await this.deps.contentRepository.findTopic(id);
    if (topic === null) throw new NotFoundError('Topic');
    if (ifMatch !== undefined && ifMatch !== topic.version)
      throw new ConflictError('The topic was changed by someone else; reload and retry', {
        details: { reason: 'VERSION_CONFLICT', currentVersion: topic.version },
      });
    await this.deps.runInTransaction(async (tx) => {
      if (
        !(await this.deps.contentRepository.updateTopic(tx, id, topic.version, patch, actor.userId))
      )
        throw new ConflictError('The topic was changed by someone else; reload and retry', {
          details: { reason: 'VERSION_CONFLICT' },
        });
      await this.deps.auditService.record(tx, actor, {
        action: 'content.topic.update',
        targetType: 'content_topic',
        targetId: id,
        before: topic,
        after: patch,
      });
    });
    await this.deps.contentService.invalidate();
    const fresh = await this.deps.contentRepository.findTopic(id);
    if (fresh === null) throw new NotFoundError('Topic');
    return fresh;
  }

  // ── Reviewer register (content.publish) ──

  listReviewers(): Promise<ReviewerRow[]> {
    return this.deps.contentRepository.listReviewers();
  }

  async createReviewer(
    actor: Actor,
    input: {
      userId: string;
      displayName: string;
      qualification: string;
      registrationNo: string;
      validUntil: string | Date;
      reason: string;
    },
  ): Promise<ReviewerRow> {
    if (input.userId === actor.userId) throw this.sod('You cannot verify your own credentials');
    return this.deps.runInTransaction(async (tx) => {
      const row = await this.deps.contentRepository.createReviewer(tx, {
        userId: input.userId,
        displayName: input.displayName,
        qualification: input.qualification,
        registrationNo: input.registrationNo,
        verifiedByUserId: actor.userId,
        validUntil: new Date(input.validUntil),
      });
      await this.deps.auditService.record(tx, actor, {
        action: 'content.reviewer.verify',
        targetType: 'content_reviewer',
        targetId: row.id,
        reason: input.reason,
        after: {
          userId: row.userId,
          registrationNo: row.registrationNo,
          validUntil: row.validUntil,
        },
      });
      return row;
    });
  }

  async updateReviewer(
    actor: Actor,
    id: string,
    ifMatch: number | undefined,
    input: {
      displayName?: string;
      qualification?: string;
      registrationNo?: string;
      validUntil?: string | Date;
      isActive?: boolean;
      reason: string;
    },
  ): Promise<ReviewerRow> {
    const reviewer = await this.deps.contentRepository.findReviewer(id);
    if (reviewer === null) throw new NotFoundError('Reviewer');
    if (reviewer.userId === actor.userId) throw this.sod('You cannot change your own credentials');
    if (ifMatch !== undefined && ifMatch !== reviewer.version)
      throw new ConflictError('The reviewer was changed by someone else; reload and retry', {
        details: { reason: 'VERSION_CONFLICT', currentVersion: reviewer.version },
      });
    const { reason, validUntil, ...rest } = input;
    const data = {
      ...rest,
      ...(validUntil === undefined ? {} : { validUntil: new Date(validUntil) }),
      // Re-verified when the credential itself changes.
      ...(input.registrationNo !== undefined || validUntil !== undefined
        ? { verifiedByUserId: actor.userId, verifiedAt: new Date() }
        : {}),
    };
    await this.deps.runInTransaction(async (tx) => {
      if (!(await this.deps.contentRepository.updateReviewer(tx, id, reviewer.version, data)))
        throw new ConflictError('The reviewer was changed by someone else; reload and retry', {
          details: { reason: 'VERSION_CONFLICT' },
        });
      await this.deps.auditService.record(tx, actor, {
        action: 'content.reviewer.update',
        targetType: 'content_reviewer',
        targetId: id,
        reason,
        before: reviewer,
        after: data,
      });
    });
    await this.deps.contentService.invalidate();
    const fresh = await this.deps.contentRepository.findReviewer(id);
    if (fresh === null) throw new NotFoundError('Reviewer');
    return fresh;
  }

  // ── Internals ──

  /**
   * Load → plan → guarded update (version + current status) + status event + audit, in one
   * transaction; cache generation bumped after commit.
   */
  private async change(
    actor: Actor,
    id: string,
    ifMatch: number | undefined,
    plan: (item: ContentRow) => Change | Promise<Change>,
  ): Promise<ContentRow> {
    const item = await this.must(id);
    this.checkVersion(item, ifMatch);
    const c = await plan(item);
    if (
      !c.from.includes(item.status) ||
      (c.to !== undefined && c.to !== item.status && !canTransition(item.status, c.to))
    )
      throw this.stateError(item, `Not allowed while ${item.status}`);
    await this.deps.runInTransaction(async (tx) => {
      const ok = await this.deps.contentRepository.update(
        tx,
        id,
        { version: item.version, status: item.status },
        { ...c.data, ...(c.to === undefined ? {} : { status: c.to }) },
        c.bumpContent === true,
      );
      if (!ok) throw this.versionError(item);
      if (c.to !== undefined && c.to !== item.status)
        await this.deps.contentRepository.insertStatusEvent(
          tx,
          id,
          item.status,
          c.to,
          actor.userId,
          c.reason ?? null,
        );
      await c.after?.(tx);
      await this.deps.auditService.record(tx, actor, {
        action: c.action,
        targetType: 'content',
        targetId: id,
        reason: c.reason ?? null,
        before: c.audit?.before ?? { status: item.status, contentVersion: item.contentVersion },
        after: { ...(c.to === undefined ? {} : { status: c.to }), ...c.audit?.after },
      });
    });
    await this.deps.contentService.invalidate();
    return this.must(id);
  }

  private async emitPublished(tx: Tx, item: ContentRow, correlationId: string): Promise<void> {
    await this.deps.outbox.add(
      tx,
      FARM_EVENTS.contentPublished,
      { ...this.eventBase(item, item.contentVersion), summary: item.summary },
      correlationId,
    );
  }

  /** Event fields: public text only (no coordinates, no targeting lists, no user ids). */
  private eventBase(
    item: Pick<ContentRow, 'id' | 'kind' | 'severity' | 'title' | 'placeLabel'>,
    contentVersion: number,
  ) {
    return {
      contentId: item.id,
      contentVersion,
      kind: item.kind,
      severity: item.severity,
      title: item.title,
      placeLabel: item.placeLabel,
    };
  }

  /** Media URLs from media-service only; area rounded; source dates as YYYY-MM-DD. */
  private normalize(fields: ContentFields): ContentFields {
    const base = this.deps.config.MEDIA_PUBLIC_BASE_URL;
    const bad: { path: string; message: string }[] = [];
    const check = (url: string | null | undefined, path: string) => {
      if (url != null && !isMediaUrl(url, base))
        bad.push({ path, message: 'Upload media through media-service' });
    };
    check(fields.heroImageUrl, 'body.heroImageUrl');
    check(fields.asset?.url, 'body.asset.url');
    fields.blocks.forEach((b, i) => {
      if (b.type === 'image' || b.type === 'video') check(b.url, `body.blocks.${String(i)}.url`);
    });
    if (bad.length > 0) throw new ValidationError(bad);
    return {
      ...fields,
      area: roundArea(fields.area),
      sources: fields.sources.map((s) => ({
        ...s,
        url: s.url ?? null,
        referenceDate: new Date(s.referenceDate).toISOString().slice(0, 10),
      })),
    };
  }

  private async activeTopic(id: string): Promise<TopicRow> {
    const topic = await this.deps.contentRepository.findTopic(id);
    if (topic?.isActive !== true)
      throw new ValidationError([{ path: 'body.topicId', message: 'Unknown or inactive topic' }]);
    return topic;
  }

  private async verifiedReviewer(userId: string): Promise<ReviewerRow> {
    const reviewer = await this.deps.contentRepository.findReviewerByUser(userId);
    if (reviewer === null || !reviewerUsable(reviewer, new Date()))
      throw new ForbiddenError('Only a verified, active reviewer can sign off', {
        details: { reason: 'REVIEWER_NOT_VERIFIED' },
      });
    return reviewer;
  }

  private async reviewerValid(item: ContentRow): Promise<boolean> {
    if (item.reviewer === null) return false;
    const reviewer = await this.deps.contentRepository.findReviewer(item.reviewer.id);
    return reviewer !== null && reviewerUsable(reviewer, new Date());
  }

  private async must(id: string): Promise<ContentRow> {
    const item = await this.deps.contentRepository.findById(id);
    if (item === null) throw new NotFoundError('Content');
    return item;
  }

  private async mustRevision(id: string, revisionId: string): Promise<RevisionRow> {
    const revision = await this.deps.contentRepository.findRevision(id, revisionId);
    if (revision === null) throw new NotFoundError('Correction');
    return revision;
  }

  private assertNotAuthor(item: ContentRow, actor: Actor, message: string): void {
    if (authorsOf(item).has(actor.userId)) throw this.sod(message);
  }

  private assertNoBlockers(issues: GateIssue[]): void {
    if (issues.length > 0)
      throw new ValidationError(
        issues.map((i) => ({ path: `content.${i.code}`, message: i.message })),
        'This item is not ready to publish',
      );
  }

  private checkVersion(item: ContentRow, ifMatch: number | undefined): void {
    if (ifMatch !== undefined && ifMatch !== item.version) throw this.versionError(item);
  }

  private versionError(item: ContentRow): ConflictError {
    return new ConflictError('This item was changed by someone else; reload and retry', {
      details: { reason: 'VERSION_CONFLICT', currentVersion: item.version },
    });
  }

  private stateError(item: ContentRow, message: string): ConflictError {
    return new ConflictError(message, {
      details: { reason: 'CONTENT_STATE_INVALID', status: item.status },
    });
  }

  private sod(message: string): ForbiddenError {
    return new ForbiddenError(message, { details: { reason: 'SOD_VIOLATION' } });
  }
}

const reviewerUsable = (r: ReviewerRow, now: Date): boolean =>
  r.isActive && new Date(r.validUntil) > now;

const columnsFor = (f: ContentFields): ItemData =>
  columnsOf(f, derive(f.blocks, f.tags, f.summary, f.asset?.durationSec ?? null));
