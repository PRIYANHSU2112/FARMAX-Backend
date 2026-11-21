import type { Cradle } from '@fastify/awilix';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Actor } from '../../src/features/audit/index.js';
import { ContentAdminService } from '../../src/features/content/content.admin.service.js';
import type { NewItem } from '../../src/features/content/content.repository.js';
import { ContentService } from '../../src/features/content/content.service.js';
import type {
  ContentRow,
  ContentStatus,
  ReviewerRow,
  RevisionRow,
  TopicRow,
} from '../../src/features/content/content.types.js';

/**
 * The authoring → review → approval → correction → takedown workflow and the reader views,
 * over an in-memory repository (the SQL itself is covered by the DB tests).
 */

const MEDIA = 'https://cdn.test/media';
const DAY = 86_400_000;
const actor = (userId: string): Actor => ({ userId, ip: '127.0.0.1', requestId: `req-${userId}` });
const AUTHOR = actor('00000000-0000-7000-8000-00000000a001');
const VET = actor('00000000-0000-7000-8000-00000000a002');
const APPROVER = actor('00000000-0000-7000-8000-00000000a003');
const READER = '00000000-0000-7000-8000-00000000b001';

const TOPIC: TopicRow = {
  id: '00000000-0000-7000-8000-00000000c001',
  code: 'DISEASE',
  name: 'Disease',
  clinical: true,
  sortOrder: 1,
  isActive: true,
  version: 0,
};

/** Minimal in-memory stand-in for ContentRepository (same method contracts). */
class FakeRepo {
  items = new Map<string, ContentRow>();
  revisions = new Map<string, RevisionRow>();
  reviewers = new Map<string, ReviewerRow>();
  events: { from: ContentStatus | null; to: ContentStatus; actor: string | null }[] = [];
  saves = new Map<string, { offline: boolean; downloadedVersion: number | null }>();

  listTopics = () => Promise.resolve([TOPIC]);
  findTopic = (id: string) => Promise.resolve(id === TOPIC.id ? TOPIC : null);
  findReviewer = (id: string) => Promise.resolve(this.reviewers.get(id) ?? null);
  findReviewerByUser = (userId: string) =>
    Promise.resolve([...this.reviewers.values()].find((r) => r.userId === userId) ?? null);
  findById = (id: string) => Promise.resolve(structuredClone(this.items.get(id) ?? null));
  listRevisions = () => Promise.resolve([...this.revisions.values()]);
  history = () => Promise.resolve([]);
  insertStatusEvent = (
    _tx: unknown,
    _id: string,
    from: ContentStatus | null,
    to: ContentStatus,
    a: string | null,
  ) => {
    this.events.push({ from, to, actor: a });
    return Promise.resolve();
  };

  create = (_tx: unknown, n: NewItem) => {
    const row = {
      id: n.id,
      slug: n.slug,
      kind: n.kind,
      topic: TOPIC,
      reviewer: null,
      status: 'DRAFT',
      isFeatured: n.isFeatured,
      notify: n.notify,
      expiresAt: n.expiresAt?.toISOString() ?? null,
      contentVersion: 1,
      version: 0,
      createdByUserId: n.userId,
      updatedByUserId: n.userId,
      submittedByUserId: null,
      clinicalSignedOffAt: null,
      signedOffHash: null,
      publishAt: null,
      publishedAt: null,
      expiredAt: null,
      retractedAt: null,
      retractNote: null,
      notifiedAt: null,
      lastCorrectedAt: null,
      correctionNote: null,
      viewCount: 0,
      helpfulYes: 0,
      helpfulNo: 0,
      saveCount: 0,
      shareCount: 0,
      trendingScore: 0,
      readMinutes: 1,
      updatedAt: new Date().toISOString(),
    } as unknown as ContentRow;
    this.apply(row, n.columns);
    this.items.set(row.id, row);
    return Promise.resolve(structuredClone(row));
  };

  update = (
    _tx: unknown,
    id: string,
    guard: { version: number; status?: ContentStatus | ContentStatus[] },
    data: Record<string, unknown>,
    bump = false,
  ) => {
    const row = this.items.get(id);
    const statuses = guard.status === undefined ? null : [guard.status].flat();
    if (row?.version !== guard.version) return Promise.resolve(false);
    if (statuses !== null && !statuses.includes(row.status)) return Promise.resolve(false);
    this.apply(row, data);
    row.version += 1;
    if (bump) row.contentVersion += 1;
    return Promise.resolve(true);
  };

  createRevision = (
    _tx: unknown,
    d: {
      contentId: string;
      baseVersion: number;
      changes: object;
      changeNote: string;
      userId: string;
    },
  ) => {
    const rev: RevisionRow = {
      id: `rev-${String(this.revisions.size + 1)}`,
      contentId: d.contentId,
      baseVersion: d.baseVersion,
      changes: structuredClone(d.changes),
      changeNote: d.changeNote,
      status: 'PENDING',
      requestedByUserId: d.userId,
      requestedAt: new Date().toISOString(),
      signedOffById: null,
      signedOffAt: null,
      decidedByUserId: null,
      decidedAt: null,
      rejectReason: null,
    };
    this.revisions.set(rev.id, rev);
    return Promise.resolve(rev);
  };
  findRevision = (_c: string, id: string) =>
    Promise.resolve(structuredClone(this.revisions.get(id) ?? null));
  signOffRevision = (_tx: unknown, id: string, reviewerId: string) => {
    const rev = this.revisions.get(id);
    if (rev?.status !== 'PENDING') return Promise.resolve(false);
    rev.signedOffById = reviewerId;
    rev.signedOffAt = new Date().toISOString();
    return Promise.resolve(true);
  };
  decideRevision = (_tx: unknown, id: string, status: 'APPLIED' | 'REJECTED', by: string) => {
    const rev = this.revisions.get(id);
    if (rev?.status !== 'PENDING') return Promise.resolve(false);
    rev.status = status;
    rev.decidedByUserId = by;
    return Promise.resolve(true);
  };

  // Reader side
  findReadable = (idOrSlug: string) => {
    const row = [...this.items.values()].find((r) => r.id === idOrSlug || r.slug === idOrSlug);
    return Promise.resolve(
      row !== undefined && ['PUBLISHED', 'EXPIRED', 'RETRACTED'].includes(row.status)
        ? structuredClone(row)
        : null,
    );
  };
  cardsByIds = () => Promise.resolve([]);
  savedIds = () => Promise.resolve(new Set<string>());
  findSave = (_u: string, id: string) => Promise.resolve(this.saves.get(id) ?? null);
  findFeedback = () => Promise.resolve(null);
  offlineSaves = () =>
    Promise.resolve(
      [...this.saves.entries()].map(([contentId, s]) => ({
        contentId,
        downloadedVersion: s.downloadedVersion,
      })),
    );
  findManyFull = (ids: string[]) =>
    Promise.resolve(
      ids.flatMap((id) => (this.items.has(id) ? [structuredClone(this.items.get(id))] : [])),
    );

  /** Prisma columns → row fields (mirror of the repository mapping). */
  private apply(row: ContentRow, data: Record<string, unknown>): void {
    const r = row as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (k === 'clinicalReviewerId') {
        const rv = v === null ? null : this.reviewers.get(v as string);
        r.reviewer =
          rv == null
            ? null
            : {
                id: rv.id,
                displayName: rv.displayName,
                qualification: rv.qualification,
                registrationNo: rv.registrationNo,
              };
      } else if (!k.startsWith('asset') && !k.startsWith('area') && k !== 'bodyText') {
        r[k] = v instanceof Date ? v.toISOString() : v;
      }
    }
    if ('assetUrl' in data)
      r.asset =
        data.assetUrl === null
          ? null
          : { url: data.assetUrl, kind: data.assetKind, mediaId: data.assetMediaId ?? null };
    if ('areaLat' in data)
      r.area = data.areaLat === null ? null : { lat: data.areaLat, lng: data.areaLng };
  }
}

let repo: FakeRepo;
let outbox: { type: string; data: Record<string, unknown> }[];
let audit: { action: string; actor: string; reason?: string | null }[];
let reader: ContentService;
let admin: ContentAdminService;

beforeEach(() => {
  repo = new FakeRepo();
  outbox = [];
  audit = [];
  repo.reviewers.set('rv-1', {
    id: 'rv-1',
    userId: VET.userId,
    displayName: 'Dr. K. Srinivas',
    qualification: 'BVSc & AH',
    registrationNo: 'APSVC-10234',
    verifiedByUserId: APPROVER.userId,
    verifiedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 365 * DAY).toISOString(),
    isActive: true,
    version: 0,
  });
  const logger = { warn: () => undefined, info: () => undefined, error: () => undefined };
  reader = new ContentService({
    contentRepository: repo,
    contentCounters: { view: () => Promise.resolve(), bump: () => undefined },
    cache: { getOrSet: (_k: string, _t: number, fn: () => Promise<unknown>) => fn() },
    redis: { get: () => Promise.resolve('1'), incr: () => Promise.resolve(2) },
    logger,
    farmsService: {
      readerContext: () =>
        Promise.resolve({
          territoryCode: 'WG',
          productionTypes: ['BROILER'],
          lat: 16.8,
          lng: 81.7,
        }),
    },
  } as unknown as ConstructorParameters<typeof ContentService>[0]);
  admin = new ContentAdminService({
    contentRepository: repo,
    contentService: reader,
    auditService: {
      record: (_tx: unknown, a: Actor, e: { action: string; reason?: string | null }) => {
        audit.push({ action: e.action, actor: a.userId, reason: e.reason ?? null });
        return Promise.resolve();
      },
    },
    outbox: {
      add: (_tx: unknown, type: string, data: Record<string, unknown>) => {
        outbox.push({ type, data });
        return Promise.resolve();
      },
    },
    runInTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    config: { MEDIA_PUBLIC_BASE_URL: MEDIA },
    logger,
  } as unknown as Pick<Cradle, 'contentRepository'> as ConstructorParameters<
    typeof ContentAdminService
  >[0]);
});

const draftAlert = () =>
  admin.create(AUTHOR, {
    kind: 'ALERT',
    topicId: TOPIC.id,
    title: 'Newcastle disease on 3 farms near Tanuku',
    summary: 'Confirmed in broiler and layer flocks around Tanuku and Attili.',
    heroImageUrl: `${MEDIA}/nd.jpg`,
    blocks: [
      { type: 'heading', text: 'Do this now' },
      { type: 'list', style: 'numbered', items: ['Stop visitors at the gate', 'Test immunity'] },
    ],
    sources: [
      { title: 'ND bulletin', publisher: 'AP AHD', url: null, referenceDate: '2026-11-18' },
    ],
    severity: 'WARNING',
    placeLabel: 'Tanuku',
    area: { lat: 16.754321, lng: 81.681234 },
  });

const publishedAlert = async () => {
  const d = await draftAlert();
  await admin.submit(AUTHOR, d.id, undefined);
  await admin.signOff(VET, d.id, undefined);
  return admin.publish(APPROVER, d.id, undefined, {});
};

const status = (code: string) => ({ details: { reason: code } });

describe('authoring with separation of duties', () => {
  it('create: alert defaults (notify, 14-day expiry), area rounded, media from media-service', async () => {
    const d = await draftAlert();
    expect(d).toMatchObject({ status: 'DRAFT', notify: true, area: { lat: 16.75, lng: 81.68 } });
    const days = (new Date(d.expiresAt ?? 0).getTime() - Date.now()) / DAY;
    expect(Math.round(days)).toBe(14);
    await expect(
      admin.create(AUTHOR, {
        kind: 'NEWS',
        topicId: TOPIC.id,
        title: 'x',
        summary: 'y',
        heroImageUrl: 'https://evil.example/x.jpg',
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('the author cannot sign off or approve; a verified vet signs, a different admin publishes', async () => {
    const d = await draftAlert();
    await admin.submit(AUTHOR, d.id, undefined);
    await expect(admin.signOff(AUTHOR, d.id, undefined)).rejects.toMatchObject({ statusCode: 403 });
    await expect(admin.signOff(APPROVER, d.id, undefined)).rejects.toMatchObject({
      statusCode: 403, // not a registered reviewer
    });
    await expect(admin.publish(APPROVER, d.id, undefined, {})).rejects.toMatchObject({
      statusCode: 422, // no sign-off yet
    });
    await admin.signOff(VET, d.id, undefined);
    await expect(admin.publish(AUTHOR, d.id, undefined, {})).rejects.toMatchObject(
      status('SOD_VIOLATION'),
    );
    const live = await admin.publish(APPROVER, d.id, undefined, {});
    expect(live).toMatchObject({ status: 'PUBLISHED', publishedByUserId: APPROVER.userId });
    expect(live.notifiedAt).not.toBeNull();
    expect(outbox.map((e) => e.type)).toEqual(['content.published.v1']);
    expect(outbox[0]?.data).toMatchObject({
      contentId: d.id,
      contentVersion: 1,
      placeLabel: 'Tanuku',
    });
    expect(JSON.stringify(outbox[0]?.data)).not.toMatch(/"(lat|lng|area|territoryCodes)"/);
    expect(repo.events.map((e) => e.to)).toEqual(['DRAFT', 'IN_REVIEW', 'PUBLISHED']);
    expect(audit.map((a) => a.action)).toEqual([
      'content.create',
      'content.submit',
      'content.sign_off',
      'content.publish',
    ]);
  });

  it('a stale If-Match is refused', async () => {
    const d = await draftAlert();
    await expect(admin.submit(AUTHOR, d.id, d.version + 5)).rejects.toMatchObject(
      status('VERSION_CONFLICT'),
    );
  });

  it('an expired reviewer registration blocks publishing', async () => {
    const d = await draftAlert();
    await admin.submit(AUTHOR, d.id, undefined);
    await admin.signOff(VET, d.id, undefined);
    const rv = repo.reviewers.get('rv-1');
    if (rv) rv.validUntil = new Date(Date.now() - DAY).toISOString();
    await expect(admin.publish(APPROVER, d.id, undefined, {})).rejects.toMatchObject({
      statusCode: 422,
    });
  });
});

describe('urgent corrections and takedowns', () => {
  it('correction: requester ≠ approver, vet sign-off required, new version + public note + push', async () => {
    const live = await publishedAlert();
    const rev = await admin.requestCorrection(AUTHOR, live.id, {
      changes: { summary: 'Confirmed in 5 flocks around Tanuku, Attili and Undi.' },
      changeNote: 'Two more farms confirmed near Undi.',
    });
    await expect(admin.approveCorrection(AUTHOR, live.id, rev.id, true)).rejects.toMatchObject(
      status('SOD_VIOLATION'),
    );
    await expect(admin.approveCorrection(APPROVER, live.id, rev.id, true)).rejects.toMatchObject(
      status('SIGNOFF_REQUIRED'),
    );
    await admin.signOffCorrection(VET, live.id, rev.id);
    const fixed = await admin.approveCorrection(APPROVER, live.id, rev.id, true);
    expect(fixed).toMatchObject({
      contentVersion: 2,
      correctionNote: 'Two more farms confirmed near Undi.',
      summary: 'Confirmed in 5 flocks around Tanuku, Attili and Undi.',
    });
    expect(fixed.lastCorrectedAt).not.toBeNull();
    expect(outbox.at(-1)).toMatchObject({
      type: 'content.corrected.v1',
      data: { contentVersion: 2, correctionNote: 'Two more farms confirmed near Undi.' },
    });
    expect(audit.map((a) => a.action)).toContain('content.correction.approve');
    // Reader sees the "Updated" note; an offline copy of v1 must be replaced.
    const d = await reader.detail(READER, live.id);
    expect(d.correction).toMatchObject({ note: 'Two more farms confirmed near Undi.' });
    repo.saves.set(live.id, { offline: true, downloadedVersion: 1 });
    const sync = await reader.sync(READER, [{ contentId: live.id, version: 1 }]);
    expect(sync.items[0]).toMatchObject({ action: 'REPLACE', contentVersion: 2 });
  });

  it('a correction written against an older version is refused', async () => {
    const live = await publishedAlert();
    const rev = await admin.requestCorrection(AUTHOR, live.id, {
      changes: { title: 'ND confirmed near Tanuku' },
      changeNote: 'Clearer headline for farmers.',
    });
    await admin.expireNow(APPROVER, live.id, undefined, 'Outbreak contained per AHD');
    await admin.signOffCorrection(VET, live.id, rev.id);
    await expect(admin.approveCorrection(APPROVER, live.id, rev.id, false)).rejects.toMatchObject(
      status('CORRECTION_STALE'),
    );
  });

  it('retract: single reasoned action; readers see only the note; offline copies are deleted', async () => {
    const live = await publishedAlert();
    repo.saves.set(live.id, { offline: true, downloadedVersion: 1 });
    await admin.retract(APPROVER, live.id, undefined, {
      reason: 'Lab results did not confirm ND',
      publicNote: 'Lab tests did not confirm Newcastle disease. Please ignore this alert.',
    });
    expect(outbox.at(-1)).toMatchObject({
      type: 'content.retracted.v1',
      data: { contentVersion: 2, wasNotified: true },
    });
    expect(audit.at(-1)).toMatchObject({
      action: 'content.retract',
      reason: 'Lab results did not confirm ND',
    });
    const d = await reader.detail(READER, live.id);
    expect(d).toMatchObject({
      status: 'RETRACTED',
      blocks: [],
      sources: [],
      ctas: [],
      summary: null,
    });
    expect(d.withdrawn?.note).toContain('did not confirm');
    const sync = await reader.sync(READER, [{ contentId: live.id, version: 1 }]);
    expect(sync.items[0]).toMatchObject({ action: 'DELETE' });
    await expect(
      admin.extend(APPROVER, live.id, undefined, {
        expiresAt: new Date(Date.now() + DAY),
        reason: 'Trying to revive a withdrawn alert',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('extend is capped at 30 days from now', async () => {
    const live = await publishedAlert();
    await expect(
      admin.extend(APPROVER, live.id, undefined, {
        expiresAt: new Date(Date.now() + 40 * DAY),
        reason: 'Outbreak still active in the area',
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    const ok = await admin.extend(APPROVER, live.id, undefined, {
      expiresAt: new Date(Date.now() + 20 * DAY),
      reason: 'Outbreak still active in the area',
    });
    expect(ok.contentVersion).toBe(2);
  });
});

describe('reader views: location privacy', () => {
  it('detail never contains coordinates, only a distance bucket and the place label', async () => {
    const live = await publishedAlert();
    const d = await reader.detail(READER, live.slug);
    expect(d).toMatchObject({ placeLabel: 'Tanuku', distance: '5–10 km' });
    expect(d.reviewer).toEqual({
      name: 'Dr. K. Srinivas',
      qualification: 'BVSc & AH',
      registrationNo: 'APSVC-10234',
    });
    const json = JSON.stringify(d);
    expect(json).not.toMatch(/"(lat|lng|latitude|longitude|area|areaLat|areaLng|territoryCodes)"/);
    expect(json).not.toContain('16.75');
  });
});
