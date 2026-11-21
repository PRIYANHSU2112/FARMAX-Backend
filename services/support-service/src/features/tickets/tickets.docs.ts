import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, AUTH_REQUESTER, IDS } from '../../docs/shared.js';
import { APPS, PRIORITIES, TEAMS } from '../../middleware/http.js';
import { CHANNELS, STATUSES } from './tickets.types.js';

export const TICKETS_TAG = 'Support Tickets';
export const ADMIN_TICKETS_TAG = 'Admin Support Queue';

const IDEMPOTENCY = {
  'Idempotency-Key': { description: 'Retry-safe create: the same key returns the same ticket (8–64 chars).' },
};
const IF_MATCH = { 'If-Match': { description: 'Ticket `version` you saw; a newer version answers 409 STALE_VERSION.' } };

const attachmentSchema = Joi.object({
  id: Joi.string().guid(),
  kind: Joi.string().valid('image', 'document'),
  mime: Joi.string().example('image/jpeg'),
  size: Joi.number().integer().example(1_887_436),
  fileName: Joi.string().allow(null).example('delivery-box.jpg'),
}).meta({ className: 'SupportAttachment' });

const orderSchema = Joi.object({
  orderNo: Joi.string().example('ORD-26-0091842'),
  status: Joi.string(),
  placedAt: Joi.date().iso(),
  grandTotal: Joi.string().example('27821.00'),
  paymentMethod: Joi.string().example('UPI'),
  itemCount: Joi.number().integer(),
  firstItemName: Joi.string().allow(null),
  temperatureClasses: Joi.array().items(Joi.string()).example(['CC_REF']),
}).allow(null).meta({ className: 'SupportOrderSnapshot' });

const ticketSchema = Joi.object({
  id: Joi.string().guid().example(IDS.ticket),
  ticketNo: Joi.string().example('TK-2026-055120'),
  app: Joi.string().valid(...APPS),
  topic: Joi.object({ code: Joi.string().example('DELIVERY_RETURNS'), label: Joi.string().example('Delivery & returns') }),
  description: Joi.string().example('IBD vials felt warm when we opened the box. Can I still use them?'),
  status: Joi.string().valid(...STATUSES),
  tab: Joi.string().valid('open', 'resolved'),
  priority: Joi.string().valid(...PRIORITIES),
  priorityReason: Joi.string().allow(null).example('cold chain'),
  team: Joi.string().valid(...TEAMS),
  agent: Joi.object({ name: Joi.string().example('Swathi') }).allow(null),
  escalationLevel: Joi.number().integer(),
  channel: Joi.string().valid(...CHANNELS),
  order: orderSchema,
  callbackRequested: Joi.boolean(),
  callbackPhone: Joi.string().allow(null).example('+91 ******4417'),
  resolveDueAt: Joi.date().iso().description('"Resolve by 4:00 pm"'),
  resolvedAt: Joi.date().iso().allow(null),
  closedAt: Joi.date().iso().allow(null),
  awaitingFeedback: Joi.boolean().description('Show "Did this solve your problem?"'),
  csat: Joi.string().valid('YES', 'NOT_YET').allow(null),
  lastSeq: Joi.number().integer(),
  lastMessageAt: Joi.date().iso(),
  lastMessagePreview: Joi.string().allow(null),
  unreadCount: Joi.number().integer(),
  version: Joi.number().integer(),
  createdAt: Joi.date().iso(),
}).meta({ className: 'SupportTicket' });

const agentTicketSchema = ticketSchema
  .keys({
    requester: Joi.object({ id: Joi.string().guid(), type: Joi.string(), name: Joi.string().allow(null) }),
    farmId: Joi.string().guid().allow(null),
    agent: Joi.object({ id: Joi.string().guid(), name: Joi.string() }).allow(null),
    callbackPhone: Joi.string().allow(null).example('+919876544417'),
    priorityLocked: Joi.boolean(),
    sla: Joi.object({
      policy: Joi.object().unknown(true),
      startedAt: Joi.date().iso(),
      firstResponseDueAt: Joi.date().iso(),
      firstRespondedAt: Joi.date().iso().allow(null),
      firstResponseBreachedAt: Joi.date().iso().allow(null),
      resolveDueAt: Joi.date().iso(),
      resolveBreachedAt: Joi.date().iso().allow(null),
      pausedAt: Joi.date().iso().allow(null),
      pausedBusinessMinutes: Joi.number().integer(),
    }),
    reopenCount: Joi.number().integer(),
    csatComment: Joi.string().allow(null),
    updatedAt: Joi.date().iso(),
  })
  .meta({ className: 'SupportTicketAgent' });

const messageSchema = Joi.object({
  id: Joi.string().guid().example(IDS.message),
  ticketId: Joi.string().guid(),
  seq: Joi.number().integer().description('Gap-free per ticket; resync with afterSeq'),
  senderRole: Joi.string().valid('REQUESTER', 'AGENT', 'SYSTEM'),
  senderName: Joi.string().allow(null).example('Swathi'),
  mine: Joi.boolean(),
  kind: Joi.string().valid('TEXT', 'SYSTEM', 'ESCALATION', 'ACTION_CARD', 'INTERNAL_NOTE'),
  visibility: Joi.string().valid('PUBLIC', 'INTERNAL').description('Agents only'),
  body: Joi.string().example('Please don\'t use them. The van logger shows 11.2 °C for 47 minutes.'),
  attachments: Joi.array().items(attachmentSchema),
  card: Joi.object().unknown(true).allow(null).example({ title: 'Return RT-26-00418 approved', subtitle: 'Refund ₹8,960 · pickup Sat 9–11 am', refType: 'RETURN', status: 'APPROVED' }),
  clientMessageId: Joi.string().allow(null),
  createdAt: Joi.date().iso(),
}).meta({ className: 'SupportMessage' });

const sendResult = Joi.object({ message: messageSchema, replayed: Joi.boolean().description('Same clientMessageId already stored') });
const urlSchema = Joi.object({ url: Joi.string().uri(), expiresInSeconds: Joi.number().integer(), mime: Joi.string(), fileName: Joi.string().allow(null) });

const req = { tag: TICKETS_TAG, auth: AUTH_REQUESTER } as const;
const adm = { tag: ADMIN_TICKETS_TAG, auth: AUTH_ADMIN } as const;

export const TICKET_DOCS = {
  create: {
    ...req,
    summary: 'Raise a ticket (New ticket)',
    description: [
      'Topic chips come from `GET /v1/support/config`; "These may answer it" from `GET /v1/support/suggestions`.',
      '**Priority is automatic**: the first matching admin rule (e.g. a cold-chain order → HIGH "cold chain"), else the topic default. SLA deadlines follow the app × priority policy (business hours, holidays).',
      '`orderId` must be one of your orders (snapshotted: order no., amount, payment, temperature classes). Evidence: upload with media-service `purpose=support` and pass the returned **receipts** (≤ 10 MB, JPEG/PNG/WebP/PDF).',
      'Auto-assigned to the least-loaded online agent of the team when one is free. Send `Idempotency-Key` to make retries safe. Open tickets per user are capped (setting).',
    ].join('\n\n'),
    rateLimit: '10 per user per hour',
    headers: IDEMPOTENCY,
    requestExample: {
      topicCode: 'DELIVERY_RETURNS',
      description: 'IBD vials felt warm when we opened the box. Can I still use them?',
      orderId: IDS.order,
      attachments: ['<receipt from media-service>'],
      callbackRequested: true,
    },
    success: { status: 201, description: 'Created (200 when replayed)', data: ticketSchema },
    errors: [409, 422, 503],
  },
  list: {
    ...req,
    summary: 'My tickets (Open / Resolved tabs)',
    description: 'Most recent activity first. `meta.counts` = `{ open, resolved }` for the tab badges. `unreadCount` excludes internal notes.',
    rateLimit: '120 per user per minute',
    success: { status: 200, description: 'Tickets', data: Joi.array().items(ticketSchema), paginated: true, meta: Joi.object({ counts: Joi.object({ open: Joi.number(), resolved: Joi.number() }) }) },
    errors: [422],
  },
  detail: { ...req, summary: 'Ticket detail', description: 'Header of the chat screen. Any other user\'s ticket answers 404.', success: { status: 200, description: 'Ticket', data: ticketSchema }, errors: [404] },
  messages: {
    ...req,
    summary: 'Ticket messages',
    description: 'Latest page by default (ascending). Older: `beforeSeq`. Resync after a reconnect: `afterSeq` = last seq you hold (gap-free). Internal notes are never returned to requesters.',
    success: { status: 200, description: 'Messages (ascending seq)', data: Joi.array().items(messageSchema) },
    errors: [404, 422],
  },
  send: {
    ...req,
    summary: 'Reply on a ticket',
    description: 'Same as the WebSocket `message.send`. `clientMessageId` makes retries safe (the stored message is returned). Replying to a ticket waiting on you resumes it; replying to a resolved ticket reopens it. Closed tickets answer 409 TICKET_CLOSED.',
    rateLimit: '30 per user per minute',
    requestExample: { clientMessageId: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d9999', body: 'Thanks, we have quarantined them.' },
    success: { status: 201, description: 'Stored (200 when replayed)', data: sendResult },
    errors: [404, 409, 422],
  },
  read: { ...req, summary: 'Mark as read up to seq', description: 'Monotonic; drives `unreadCount` and the agent\'s "seen" tick.', requestExample: { seq: 7 }, success: { status: 200, description: 'Read pointer', data: Joi.object({ ticketId: Joi.string().guid(), lastReadSeq: Joi.number().integer() }) }, errors: [404, 422] },
  feedback: {
    ...req,
    summary: 'Did this solve your problem?',
    description: '`resolved: true` closes the ticket; `false` ("Not yet") reopens it with a fresh resolution deadline. Only on RESOLVED tickets (409 otherwise).',
    requestExample: { resolved: true },
    success: { status: 200, description: 'Ticket', data: ticketSchema },
    errors: [404, 409, 422],
  },
  close: { ...req, summary: 'Withdraw a ticket', description: 'Closes an open ticket.', requestExample: { reason: 'Sorted it out myself' }, success: { status: 200, description: 'Ticket', data: ticketSchema }, errors: [404, 409, 422] },
  attachmentUrl: { ...req, summary: 'Open an attachment', description: 'Signed URL valid for 5 minutes. Files are private; only ticket participants and agents get URLs.', success: { status: 200, description: 'Signed URL', data: urlSchema }, errors: [404, 503] },

  queue: {
    ...adm,
    permission: 'support.view',
    summary: 'Agent queue',
    description: 'Active tickets by default. `sort=priority_sla` (URGENT first, then earliest resolution deadline), `recent`, `oldest`. Filters: `status`, `priority` (repeat or comma), `app`, `team`, `assignee=me|unassigned|<userId>`, `breached`, `q` (ticket no., requester name, order no.).',
    success: { status: 200, description: 'Tickets', data: Joi.array().items(agentTicketSchema), paginated: true },
    errors: [422],
  },
  stats: {
    ...adm,
    permission: 'support.view',
    summary: 'Queue stats',
    description: 'Active tickets by status and priority, unassigned, mine, breached.',
    success: { status: 200, description: 'Stats', data: Joi.object({ byStatus: Joi.object().unknown(true), byPriority: Joi.object().unknown(true), unassigned: Joi.number(), mine: Joi.number(), breached: Joi.number() }) },
  },
  adminDetail: { ...adm, permission: 'support.view', summary: 'Ticket (agent view)', description: 'Full SLA state, requester, call-back phone and the attributed history (`events`).', success: { status: 200, description: 'Ticket', data: agentTicketSchema.keys({ events: Joi.array().items(Joi.object().unknown(true)) }) }, errors: [404] },
  adminMessages: { ...adm, permission: 'support.view', summary: 'Ticket messages (agent view)', description: 'Includes internal notes (`visibility: INTERNAL`).', success: { status: 200, description: 'Messages', data: Joi.array().items(messageSchema) }, errors: [404, 422] },
  adminSend: {
    ...adm,
    permission: 'support.manage',
    summary: 'Reply, internal note or action card',
    description: '`kind`: `TEXT` (public; the first public reply claims an unassigned ticket and stops the first-response clock), `INTERNAL_NOTE` (agents only), `ACTION_CARD` (`card`: e.g. "Return RT-26-00418 approved"). Retry-safe with `clientMessageId`.',
    rateLimit: '120 writes per user per minute',
    requestExample: { clientMessageId: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d8888', kind: 'ACTION_CARD', card: { title: 'Return RT-26-00418 approved', subtitle: 'Refund ₹8,960 · pickup Sat 9–11 am', refType: 'RETURN', refId: 'RT-26-00418', status: 'APPROVED' } },
    success: { status: 201, description: 'Stored (200 when replayed)', data: sendResult },
    errors: [404, 409, 422],
  },
  adminRead: { ...adm, permission: 'support.view', summary: 'Mark as read (agent)', description: 'Shows the requester a "seen" tick.', success: { status: 200, description: 'Read pointer', data: Joi.object({ ticketId: Joi.string().guid(), lastReadSeq: Joi.number() }) }, errors: [404, 422] },
  claim: { ...adm, permission: 'support.manage', summary: 'Claim a ticket', description: 'Atomic: of two agents claiming at once, exactly one wins; the other gets 409 ALREADY_ASSIGNED. Adds "<name> · Support joined".', success: { status: 200, description: 'Ticket', data: agentTicketSchema }, errors: [404, 409] },
  assign: { ...adm, permission: 'support.assign', summary: 'Assign / reassign', description: 'Moves the open-ticket load between agents. `If-Match` guards concurrent edits.', headers: IF_MATCH, requestExample: { assigneeId: IDS.agent, reason: 'Vet on shift' }, success: { status: 200, description: 'Ticket', data: agentTicketSchema }, errors: [403, 404, 409, 422] },
  escalate: {
    ...adm,
    permission: 'support.escalate',
    summary: 'Escalate (e.g. to a vet)',
    description: 'Team change (+ optional agent), level + 1. `reason` is internal; `note` is shown to the requester ("Escalated to Dr. K. Srinivas — he has your order, batch, photos and logger data. No need to repeat.").',
    headers: IF_MATCH,
    requestExample: { team: 'VET', assigneeId: IDS.agent, reason: 'Biological product above 8 °C', note: 'Escalated to Dr. K. Srinivas. He has your order, batch, photos and logger data. No need to repeat.' },
    success: { status: 200, description: 'Ticket', data: agentTicketSchema },
    errors: [403, 404, 409, 422],
  },
  priority: { ...adm, permission: 'support.manage', summary: 'Change priority', description: 'Locks the priority against rules and recomputes the SLA deadlines from the original start (a past deadline is breached by the next sweep). Needs `reason`.', headers: IF_MATCH, requestExample: { priority: 'URGENT', reason: 'Whole flock at risk' }, success: { status: 200, description: 'Ticket', data: agentTicketSchema }, errors: [404, 409, 422] },
  status: {
    ...adm,
    permission: 'support.manage',
    summary: 'Change status',
    description: 'State machine: OPEN ⇄ WAITING_ON_REQUESTER (pauses / resumes the resolution clock), → RESOLVED (asks the requester for feedback; auto-closes after the setting), → CLOSED (needs `reason`), RESOLVED → OPEN (reopen). Invalid moves answer 409 INVALID_TRANSITION.',
    headers: IF_MATCH,
    requestExample: { to: 'RESOLVED' },
    success: { status: 200, description: 'Ticket', data: agentTicketSchema },
    errors: [404, 409, 422],
  },
  intake: {
    ...adm,
    permission: 'support.manage',
    summary: 'Log a phone / email / WhatsApp ticket',
    description: 'One queue for every channel: the agent raises the ticket for the requester (same topics, rules and SLA) and owns it.',
    headers: IDEMPOTENCY,
    requestExample: { requesterId: IDS.user, channel: 'PHONE', topicCode: 'PAYMENT', description: 'Caller says UPI was debited twice.' },
    success: { status: 201, description: 'Created', data: agentTicketSchema },
    errors: [409, 422, 503],
  },
  adminAttachmentUrl: { ...adm, permission: 'support.view', summary: 'Open an attachment (agent)', description: 'Signed URL valid for 5 minutes.', success: { status: 200, description: 'Signed URL', data: urlSchema }, errors: [404, 503] },
} satisfies Record<string, RouteDocs>;
