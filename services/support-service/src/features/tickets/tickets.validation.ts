import Joi from 'joi';

import { APPS, ID, PRIORITIES, REASON, TEAMS } from '../../middleware/http.js';
import { CHANNELS, STATUSES } from './tickets.types.js';

const CODE = Joi.string().pattern(/^[A-Z][A-Z0-9_]{1,39}$/);
/** Signed upload receipts from media-service (`purpose=support`), never raw keys or URLs. */
export const RECEIPTS = Joi.array().items(Joi.string().max(2048)).max(10);
const BODY = Joi.string().trim().max(4000);
export const CLIENT_MESSAGE_ID = Joi.string().pattern(/^[A-Za-z0-9_.:-]{8,64}$/).messages({
  'string.pattern.base': 'must be 8–64 characters [A-Za-z0-9_.:-] (a UUID works)',
});

export const createTicketBody = Joi.object({
  topicCode: CODE.required(),
  description: Joi.string().trim().min(5).max(2000).required(),
  orderId: ID,
  attachments: RECEIPTS,
  callbackRequested: Joi.boolean(),
  channel: Joi.string().valid('APP', 'CHAT'),
});

export const intakeBody = createTicketBody.keys({
  requesterId: ID.required(),
  channel: Joi.string().valid('PHONE', 'EMAIL', 'WHATSAPP').required(),
});

export const messageBody = Joi.object({
  clientMessageId: CLIENT_MESSAGE_ID.required(),
  body: BODY.allow(''),
  attachments: RECEIPTS,
}).or('body', 'attachments').custom((v: { body?: string; attachments?: string[] }, h) =>
  (v.body ?? '') === '' && (v.attachments?.length ?? 0) === 0 ? h.error('any.invalid') : v,
).messages({ 'any.invalid': 'a message needs text or at least one file' });

export const ACTION_CARD = Joi.object({
  title: Joi.string().trim().min(2).max(120).required(),
  subtitle: Joi.string().trim().max(200),
  refType: Joi.string().valid('RETURN', 'REFUND', 'REPLACEMENT', 'ORDER', 'OTHER').required(),
  refId: Joi.string().trim().max(64),
  status: Joi.string().valid('APPROVED', 'REJECTED', 'PENDING', 'INFO').required(),
});

export const agentMessageBody = Joi.object({
  clientMessageId: CLIENT_MESSAGE_ID.required(),
  kind: Joi.string().valid('TEXT', 'INTERNAL_NOTE', 'ACTION_CARD').default('TEXT'),
  body: BODY.allow('').default(''),
  attachments: RECEIPTS,
  card: ACTION_CARD.when('kind', { is: 'ACTION_CARD', then: Joi.required(), otherwise: Joi.forbidden() }),
}).custom((v: { kind: string; body: string; attachments?: string[]; card?: { title: string } }, h) => {
  if (v.kind === 'ACTION_CARD') return { ...v, body: v.body === '' ? v.card?.title ?? '' : v.body };
  return v.body === '' && (v.attachments?.length ?? 0) === 0 ? h.error('any.invalid') : v;
}).messages({ 'any.invalid': 'a message needs text or at least one file' });

export const messagesQuery = Joi.object({
  afterSeq: Joi.number().integer().min(0),
  beforeSeq: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100).default(50),
}).oxor('afterSeq', 'beforeSeq');

export const listQuery = Joi.object({
  tab: Joi.string().valid('open', 'resolved').default('open'),
  cursor: ID,
  limit: Joi.number().integer().min(1).max(100).default(20),
});

const csv = (values: readonly string[]) =>
  Joi.array().items(Joi.string().valid(...values)).single().max(values.length);

export const queueQuery = Joi.object({
  status: csv(STATUSES),
  priority: csv(PRIORITIES),
  app: Joi.string().valid(...APPS),
  team: Joi.string().valid(...TEAMS),
  assignee: Joi.alternatives(Joi.string().valid('me', 'unassigned'), ID),
  breached: Joi.boolean(),
  q: Joi.string().trim().min(2).max(60),
  sort: Joi.string().valid('priority_sla', 'recent', 'oldest').default('priority_sla'),
  cursor: ID,
  limit: Joi.number().integer().min(1).max(100).default(30),
});

export const feedbackBody = Joi.object({ resolved: Joi.boolean().required(), comment: Joi.string().trim().max(500) });
export const closeBody = Joi.object({ reason: Joi.string().trim().max(500) });
export const readBody = Joi.object({ seq: Joi.number().integer().min(0).required() });
export const assignBody = Joi.object({ assigneeId: ID.required(), reason: REASON });
export const escalateBody = Joi.object({
  team: Joi.string().valid(...TEAMS).required(),
  assigneeId: ID,
  reason: REASON.required().description('Internal; history only'),
  note: Joi.string().trim().min(2).max(1000).description('Public message to the requester'),
});
export const priorityBody = Joi.object({ priority: Joi.string().valid(...PRIORITIES).required(), reason: REASON.required() });
export const statusBody = Joi.object({ to: Joi.string().valid('OPEN', 'WAITING_ON_REQUESTER', 'RESOLVED', 'CLOSED').required(), reason: REASON });
export const attachmentParams = Joi.object({ id: ID.required(), attachmentId: ID.required() });
export { CHANNELS };
