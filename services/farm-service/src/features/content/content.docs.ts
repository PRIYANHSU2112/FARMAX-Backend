import type { DocHeader, RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, AUTH_CUSTOMER, IDEMPOTENCY_KEY } from '../../docs/shared.js';
import { CONTENT_KINDS, CONTENT_STATUSES, SEVERITIES } from './content.types.js';

export const CONTENT_TAG = 'News & knowledge';
export const ADMIN_CONTENT_TAG = 'Admin · Content';

const IF_MATCH: Record<string, DocHeader> = {
  'If-Match': {
    description:
      'Item / topic / reviewer `version` from the last read. If it differs → 409 `VERSION_CONFLICT`. Optional, recommended on every write.',
    schema: { type: 'string', example: '"3"' },
  },
};
const IF_NONE_MATCH: Record<string, DocHeader> = {
  'If-None-Match': {
    description: 'ETag of the copy you hold → 304 Not Modified when nothing changed.',
    schema: { type: 'string', example: 'W/"9b2f1c0e5a7d"' },
  },
};

const uuid = Joi.string().guid();
const date = Joi.date().iso();
const PRIVACY =
  ' **Privacy:** responses never contain farm or reader coordinates; distance is a coarse bucket.';

const topic = Joi.object({
  code: Joi.string().example('DISEASE'),
  name: Joi.string().example('Disease'),
}).meta({ className: 'ContentTopic' });

const distance = Joi.string()
  .valid('<5 km', '5–10 km', '10–25 km', '25–50 km', '50+ km')
  .allow(null)
  .description('Reader farm → alert area, bucketed');

const card = Joi.object({
  id: uuid,
  slug: Joi.string().example('newcastle-disease-on-3-farms-near-tanuku-4f2a9c'),
  kind: Joi.string().valid(...CONTENT_KINDS),
  topic,
  title: Joi.string().example('Newcastle disease on 3 farms near Tanuku'),
  summary: Joi.string().example('Confirmed in broiler and layer flocks around Tanuku and Attili.'),
  heroImageUrl: Joi.string().allow(null),
  readMinutes: Joi.number().integer().example(4),
  publishedAt: date.allow(null),
  isFeatured: Joi.boolean(),
  severity: Joi.string()
    .valid(...SEVERITIES)
    .allow(null),
  placeLabel: Joi.string().allow(null).example('Tanuku'),
  distance,
  assetKind: Joi.string().valid('video', 'pdf').allow(null),
  durationSec: Joi.number().integer().allow(null),
  pageCount: Joi.number().integer().allow(null),
  viewCount: Joi.number().integer().example(23000),
  saved: Joi.boolean(),
}).meta({ className: 'ContentCard' });

const block = Joi.object({
  type: Joi.string().valid('heading', 'paragraph', 'list', 'callout', 'image', 'video'),
  text: Joi.string(),
  style: Joi.string().valid('bullet', 'numbered'),
  items: Joi.array().items(Joi.string()),
  tone: Joi.string().valid('info', 'warning'),
  url: Joi.string(),
  caption: Joi.string().allow(null),
  durationSec: Joi.number().allow(null),
}).meta({ className: 'ContentBlock' });

const source = Joi.object({
  title: Joi.string().example('ND outbreak bulletin'),
  publisher: Joi.string().example('AP Animal Husbandry Dept.'),
  url: Joi.string().allow(null),
  referenceDate: Joi.string().example('2026-07-16'),
}).meta({ className: 'ContentSource' });

const cta = Joi.object({
  type: Joi.string().valid('PRODUCT', 'CATEGORY', 'CONSULT', 'LAB_TEST', 'SALES_CALL', 'DEEP_LINK'),
  target: Joi.string().allow(null),
  label: Joi.string().example('ND LaSota booster'),
  style: Joi.string().valid('primary', 'secondary'),
}).meta({ className: 'ContentCta' });

const asset = Joi.object({
  url: Joi.string(),
  mediaId: uuid.allow(null),
  kind: Joi.string().valid('video', 'pdf'),
  sizeBytes: Joi.number().allow(null),
  durationSec: Joi.number().allow(null),
  pageCount: Joi.number().allow(null),
}).meta({ className: 'ContentAsset' });

const myState = Joi.object({
  saved: Joi.boolean(),
  offline: Joi.boolean(),
  downloadedVersion: Joi.number().integer().allow(null),
  helpful: Joi.boolean().allow(null),
}).meta({ className: 'ContentMyState' });

const detail = Joi.object({
  id: uuid,
  slug: Joi.string(),
  kind: Joi.string().valid(...CONTENT_KINDS),
  status: Joi.string().valid('PUBLISHED', 'EXPIRED', 'RETRACTED'),
  topic,
  title: Joi.string(),
  summary: Joi.string().allow(null).description('null when withdrawn'),
  heroImageUrl: Joi.string().allow(null),
  blocks: Joi.array().items(block).description('Empty when withdrawn'),
  sources: Joi.array().items(source),
  ctas: Joi.array().items(cta),
  tags: Joi.array().items(Joi.string()),
  asset: asset.allow(null),
  severity: Joi.string()
    .valid(...SEVERITIES)
    .allow(null),
  placeLabel: Joi.string().allow(null),
  distance,
  readMinutes: Joi.number().integer(),
  reviewer: Joi.object({
    name: Joi.string().example('Dr. K. Srinivas'),
    qualification: Joi.string().example('BVSc & AH'),
    registrationNo: Joi.string().example('APSVC-10234'),
  })
    .allow(null)
    .description('Verified vet who signed it off'),
  publishedAt: date.allow(null),
  expiresAt: date.allow(null),
  ended: Joi.object({ at: date }).allow(null).description('Alert expired: show "ended" banner'),
  correction: Joi.object({ at: date, note: Joi.string() })
    .allow(null)
    .description('Show "Updated <at>: <note>"'),
  withdrawn: Joi.object({ at: date, note: Joi.string() })
    .allow(null)
    .description('Withdrawn as incorrect: show ONLY this note'),
  contentVersion: Joi.number().integer(),
  viewCount: Joi.number().integer(),
  helpful: Joi.object({ yes: Joi.number(), no: Joi.number() }),
  related: Joi.array().items(card),
  me: myState,
}).meta({ className: 'ContentDetail' });

const feedPage = Joi.object({
  featured: Joi.array().items(card).description('First unfiltered page only'),
  items: Joi.array().items(card),
  nextCursor: uuid.allow(null),
  limit: Joi.number().integer(),
}).meta({ className: 'ContentFeedPage' });

const libraryItem = card
  .keys({
    savedAt: date,
    offline: Joi.boolean(),
    downloadedVersion: Joi.number().integer().allow(null),
    contentVersion: Joi.number().integer(),
    status: Joi.string().valid(...CONTENT_STATUSES),
    asset: asset.allow(null),
  })
  .meta({ className: 'ContentLibraryItem' });

const syncResult = Joi.object({
  items: Joi.array().items(
    Joi.object({
      contentId: uuid,
      action: Joi.string().valid('KEEP', 'REPLACE', 'DOWNLOAD', 'MARK_ENDED', 'DELETE'),
      contentVersion: Joi.number().integer().allow(null),
      item: detail.allow(null).description('Full payload for REPLACE / DOWNLOAD'),
      note: Joi.string().allow(null),
    }),
  ),
  serverTime: date,
  revalidateBy: date.description('Sync again before this time or treat copies as stale'),
}).meta({ className: 'ContentSyncResult' });

// ── Admin shapes ──

const adminItem = Joi.object({
  id: uuid,
  slug: Joi.string(),
  kind: Joi.string().valid(...CONTENT_KINDS),
  topic: Joi.object({ id: uuid, code: Joi.string(), name: Joi.string(), clinical: Joi.boolean() }),
  title: Joi.string(),
  summary: Joi.string(),
  blocks: Joi.array().items(block),
  sources: Joi.array().items(source),
  ctas: Joi.array().items(cta),
  asset: asset.allow(null),
  severity: Joi.string().allow(null),
  placeLabel: Joi.string().allow(null),
  area: Joi.object({ lat: Joi.number(), lng: Joi.number() })
    .allow(null)
    .description('Alert area centre (~1 km); admin only'),
  productionTypes: Joi.array().items(Joi.string()),
  territoryCodes: Joi.array().items(Joi.string()),
  reviewer: Joi.object().allow(null),
  clinicalSignedOffAt: date.allow(null),
  status: Joi.string().valid(...CONTENT_STATUSES),
  notify: Joi.boolean(),
  publishAt: date.allow(null),
  publishedAt: date.allow(null),
  expiresAt: date.allow(null),
  retractNote: Joi.string().allow(null),
  correctionNote: Joi.string().allow(null),
  contentVersion: Joi.number().integer(),
  version: Joi.number().integer().description('Send back as If-Match'),
  createdByUserId: uuid,
  submittedByUserId: uuid.allow(null),
  publishedByUserId: uuid.allow(null),
}).meta({ className: 'AdminContentItem' });

const revision = Joi.object({
  id: uuid,
  contentId: uuid,
  baseVersion: Joi.number().integer(),
  changes: Joi.object(),
  changeNote: Joi.string(),
  status: Joi.string().valid('PENDING', 'APPLIED', 'REJECTED'),
  requestedByUserId: uuid,
  signedOffById: uuid.allow(null),
  decidedByUserId: uuid.allow(null),
  rejectReason: Joi.string().allow(null),
}).meta({ className: 'ContentCorrection' });

const adminDetail = Joi.object({
  item: adminItem,
  revisions: Joi.array().items(revision),
  history: Joi.array().items(
    Joi.object({
      from: Joi.string().allow(null),
      to: Joi.string(),
      actorUserId: uuid.allow(null),
      reason: Joi.string().allow(null),
      createdAt: date,
    }),
  ),
  blockers: Joi.array()
    .items(Joi.object({ code: Joi.string(), message: Joi.string() }))
    .description('Why it cannot be published yet'),
}).meta({ className: 'AdminContentDetail' });

const topicRow = Joi.object({
  id: uuid,
  code: Joi.string(),
  name: Joi.string(),
  clinical: Joi.boolean(),
  sortOrder: Joi.number(),
  isActive: Joi.boolean(),
  version: Joi.number(),
}).meta({ className: 'AdminContentTopic' });

const reviewer = Joi.object({
  id: uuid,
  userId: uuid,
  displayName: Joi.string(),
  qualification: Joi.string(),
  registrationNo: Joi.string(),
  verifiedByUserId: uuid,
  verifiedAt: date,
  validUntil: date,
  isActive: Joi.boolean(),
  version: Joi.number(),
}).meta({ className: 'ContentReviewer' });

const SOD = {
  summary: 'SOD_VIOLATION',
  message: 'The author cannot approve their own content',
  details: { reason: 'SOD_VIOLATION' },
};
const STATE = {
  summary: 'CONTENT_STATE_INVALID',
  message: 'Not allowed while PUBLISHED',
  details: { reason: 'CONTENT_STATE_INVALID', status: 'PUBLISHED' },
};
const VERSION = {
  summary: 'VERSION_CONFLICT',
  message: 'This item was changed by someone else; reload and retry',
  details: { reason: 'VERSION_CONFLICT', currentVersion: 4 },
};
const GATE = {
  message: 'This item is not ready to publish',
  details: {
    issues: [
      { path: 'content.SIGNOFF_REQUIRED', message: 'A verified vet must sign this off' },
      { path: 'content.SOURCE_REQUIRED', message: 'Cite at least one source' },
    ],
  },
};

const admin = (
  summary: string,
  permission: string,
  extra: Partial<RouteDocs> = {},
  data: Joi.Schema = adminItem,
): RouteDocs => ({
  tag: ADMIN_CONTENT_TAG,
  summary,
  auth: AUTH_ADMIN,
  permission,
  headers: IF_MATCH,
  success: { status: 200, description: 'Updated item', data },
  errors: [404, 409, 422],
  errorExamples: { 409: [STATE, VERSION] },
  ...extra,
});

export const CONTENT_DOCS = {
  // ── Reader ──
  topics: {
    tag: CONTENT_TAG,
    summary: 'Topic chips',
    auth: AUTH_CUSTOMER,
    success: { status: 200, description: 'Active topics in order', data: Joi.array().items(topic) },
  },
  feed: {
    tag: CONTENT_TAG,
    summary: 'News & updates feed (one call: featured + cards)',
    description:
      'Targeted by the reader farm (territory + production types; `farmId` picks a farm, default = most recent live farm). `sort=trending` ranks by engagement decayed by age. Cached per segment for 60 s.' +
      PRIVACY,
    auth: AUTH_CUSTOMER,
    success: { status: 200, description: 'Feed page', data: feedPage },
    errors: [404, 422],
  },
  search: {
    tag: CONTENT_TAG,
    summary: 'Search news and the knowledge library',
    description:
      'English full-text search (quotes, `-word`, `or`) with prefix match on the last word, ranked by relevance. Same targeting as the feed.',
    auth: AUTH_CUSTOMER,
    rateLimit: '60 per user per minute',
    success: { status: 200, description: 'Matching cards', data: card, paginated: true },
    errors: [422],
  },
  detail: {
    tag: CONTENT_TAG,
    summary: 'Article / disease alert',
    description:
      'Body blocks, cited sources, the verified reviewer byline, CTAs, related items and your state. EXPIRED → `ended`; corrected → `correction`; withdrawn → only `withdrawn` (no advice is shown). Records one view per reader per day.' +
      PRIVACY,
    auth: AUTH_CUSTOMER,
    headers: IF_NONE_MATCH,
    success: {
      status: 200,
      description: 'Item (304 when the ETag matches)',
      data: detail,
      headers: {
        ETag: { description: 'Weak ETag of this response' },
        'Cache-Control': { description: '`private, no-cache`' },
      },
    },
    errors: [404, 422],
  },
  save: {
    tag: CONTENT_TAG,
    summary: 'Save / download for offline (idempotent)',
    description:
      '`offline: true` adds it to "Saved for offline" (max 50); after downloading send `downloadedVersion` = the `contentVersion` you stored. Library max 500.',
    auth: AUTH_CUSTOMER,
    success: { status: 200, description: 'Your state', data: myState },
    errors: [404, 409, 422],
    errorExamples: {
      409: [
        {
          summary: 'OFFLINE_LIMIT',
          message: 'Too many offline downloads; remove some first',
          details: { reason: 'OFFLINE_LIMIT', limit: 50 },
        },
        {
          summary: 'CONTENT_ENDED',
          message: 'This alert has ended and can no longer be saved',
          details: { reason: 'CONTENT_ENDED' },
        },
      ],
    },
  },
  unsave: {
    tag: CONTENT_TAG,
    summary: 'Remove from library (idempotent)',
    auth: AUTH_CUSTOMER,
    success: { status: 204, description: 'Removed' },
    errors: [422],
  },
  feedback: {
    tag: CONTENT_TAG,
    summary: 'Was this useful? (one vote, changeable)',
    auth: AUTH_CUSTOMER,
    success: { status: 200, description: 'Your state', data: myState },
    errors: [404, 422],
  },
  share: {
    tag: CONTENT_TAG,
    summary: 'Count a share',
    auth: AUTH_CUSTOMER,
    rateLimit: '30 per user per minute',
    success: { status: 204, description: 'Counted' },
    errors: [404, 422],
  },
  library: {
    tag: CONTENT_TAG,
    summary: 'Knowledge library (saved items)',
    description: '`offline=true` → "Saved for offline" with asset size, duration and pages.',
    auth: AUTH_CUSTOMER,
    success: {
      status: 200,
      description: 'Saved items, newest first',
      data: libraryItem,
      paginated: true,
    },
    errors: [422],
  },
  sync: {
    tag: CONTENT_TAG,
    summary: 'Offline sync (on reconnect)',
    description:
      'Send the offline copies you hold (`held[{contentId, version}]`). Per item: `KEEP`; `REPLACE` (corrected/updated: full payload + note; then PUT save with the new `downloadedVersion`); `DOWNLOAD` (saved offline on another device); `MARK_ENDED` (alert expired: keep with an "ended" banner, it is deleted after 7 days); `DELETE` (withdrawn as wrong — delete the copy and its asset now and show `note` —, archived or unsaved). Sync again before `revalidateBy`.',
    auth: AUTH_CUSTOMER,
    success: { status: 200, description: 'Actions', data: syncResult },
    errors: [422],
  },

  // ── Admin ──
  list: {
    tag: ADMIN_CONTENT_TAG,
    summary: 'Search content (incl. alerts expiring soon)',
    auth: AUTH_ADMIN,
    permission: 'content.view',
    success: { status: 200, description: 'Items, newest first', data: adminItem, paginated: true },
    errors: [422],
  },
  get: admin('Item with corrections, status history and publish blockers', 'content.view', {
    headers: {},
    success: { status: 200, description: 'Item', data: adminDetail },
    errors: [404, 422],
  }),
  stats: admin('Engagement of one item', 'content.view', {
    headers: {},
    success: {
      status: 200,
      description: 'Counters (up to 60 s behind)',
      data: Joi.object({
        views: Joi.number(),
        saves: Joi.number(),
        shares: Joi.number(),
        helpfulYes: Joi.number(),
        helpfulNo: Joi.number(),
        helpfulRate: Joi.number().allow(null),
      }),
    },
    errors: [404, 422],
  }),
  create: {
    tag: ADMIN_CONTENT_TAG,
    summary: 'Create a draft',
    description:
      'ALERT defaults: `notify: true`, `expiresAt` = now + 14 days. Media URLs must come from media-service (`POST /v1/media`). `area` is rounded to ~1 km and never shown to readers.',
    auth: AUTH_ADMIN,
    permission: 'content.manage',
    headers: IDEMPOTENCY_KEY,
    success: { status: 201, description: 'Draft', data: adminItem },
    errors: [409, 422],
  },
  update: admin('Edit a draft', 'content.manage', {
    description: 'DRAFT only. An item in review must be rejected back to draft first.',
  }),
  remove: admin('Delete a draft', 'content.manage', {
    success: { status: 204, description: 'Deleted' },
  }),
  submit: admin('Submit for review', 'content.manage', {
    description: 'Runs the publish checks except sign-off (sources, alert expiry, severity, area).',
    errorExamples: { 409: [STATE, VERSION], 422: GATE },
  }),
  signOff: admin('Clinical sign-off (verified vet)', 'content.review', {
    description:
      'Caller must be an active reviewer with an unexpired registration and not an author. The sign-off is bound to a hash of the reader-visible text: any later edit voids it.',
    errorExamples: { 403: SOD, 409: [STATE, VERSION] },
  }),
  publish: admin('Approve: publish now or schedule', 'content.publish', {
    description:
      'Approver ≠ author (403 `SOD_VIOLATION`). Clinical items (ALERT / clinical topic): ≥ 1 source + a current vet sign-off. ALERT: severity, place and `expiresAt` ≤ 30 days. `notify` pushes to the target segment (`content.published.v1`).',
    errorExamples: { 403: SOD, 409: [STATE, VERSION], 422: GATE },
  }),
  reject: admin('Send back to draft', 'content.publish'),
  extend: admin('Extend a live / ended alert', 'content.publish', {
    description:
      'New expiry ≤ 30 days from now; needs a sign-off younger than 30 days (409 `SIGNOFF_STALE`).',
  }),
  expireNow: admin('Emergency: end an alert now', 'content.publish', {
    description: 'Single-person takedown with a reason (audited). Offline copies get `MARK_ENDED`.',
  }),
  retract: admin('Emergency: withdraw as incorrect (final)', 'content.publish', {
    description:
      'Readers see only `publicNote`; offline copies are deleted on sync; savers (and the segment, if it was pushed) get a "withdrawn" notification.',
  }),
  archive: admin('Archive', 'content.publish'),
  restore: admin('Restore an archived item to draft', 'content.publish'),
  requestCorrection: admin('Propose a correction to a live item', 'content.manage', {
    headers: {},
    description:
      'Creates a PENDING correction (one at a time). Clinical items then need a vet sign-off; a DIFFERENT admin approves it. `changeNote` is shown to readers.',
    success: { status: 201, description: 'Pending correction', data: revision },
  }),
  signOffCorrection: admin('Clinical sign-off of a correction', 'content.review', {
    headers: {},
    success: { status: 200, description: 'Correction', data: revision },
    errorExamples: { 403: SOD },
  }),
  approveCorrection: admin('Approve and apply a correction', 'content.publish', {
    headers: {},
    description:
      'Approver ≠ requester. Applies the change, bumps `contentVersion` (offline copies get `REPLACE`), shows the "Updated" note, optional push (`content.corrected.v1`).',
    errorExamples: {
      403: SOD,
      409: [
        {
          summary: 'CORRECTION_STALE',
          message: 'The item changed after this correction was written; reject it and re-request',
          details: { reason: 'CORRECTION_STALE' },
        },
      ],
    },
  }),
  rejectCorrection: admin('Reject a correction', 'content.publish', {
    headers: {},
    success: { status: 200, description: 'Correction', data: revision },
  }),
  topicsList: {
    tag: ADMIN_CONTENT_TAG,
    summary: 'All topics',
    auth: AUTH_ADMIN,
    permission: 'content.view',
    success: { status: 200, description: 'Topics', data: Joi.array().items(topicRow) },
  },
  topicCreate: {
    tag: ADMIN_CONTENT_TAG,
    summary: 'Create a topic chip',
    description: '`clinical: true` → its items need a vet sign-off and sources.',
    auth: AUTH_ADMIN,
    permission: 'content.manage',
    success: { status: 201, description: 'Topic', data: topicRow },
    errors: [409, 422],
  },
  topicUpdate: admin('Edit a topic', 'content.manage', {
    success: { status: 200, description: 'Topic', data: topicRow },
  }),
  reviewersList: {
    tag: ADMIN_CONTENT_TAG,
    summary: 'Verified reviewer register',
    auth: AUTH_ADMIN,
    permission: 'content.publish',
    success: { status: 200, description: 'Reviewers', data: Joi.array().items(reviewer) },
  },
  reviewerCreate: {
    tag: ADMIN_CONTENT_TAG,
    summary: 'Register a verified vet reviewer',
    description:
      'After checking the Veterinary Council registration. You cannot verify yourself (403). Audited with a reason.',
    auth: AUTH_ADMIN,
    permission: 'content.publish',
    success: { status: 201, description: 'Reviewer', data: reviewer },
    errors: [409, 422],
  },
  reviewerUpdate: admin('Update / deactivate a reviewer', 'content.publish', {
    success: { status: 200, description: 'Reviewer', data: reviewer },
  }),
} satisfies Record<string, RouteDocs>;
