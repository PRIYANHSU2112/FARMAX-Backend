import type { MessageView, TicketRow } from './tickets.types.js';

/** +91 ******4417 */
export const maskPhone = (phone: string | null): string | null =>
  phone === null ? null : `${phone.slice(0, 3)} ******${phone.slice(-4)}`;

const DONE = new Set(['RESOLVED', 'CLOSED']);

/** What the requester's app sees (no internal ids of staff, masked phone). */
export const requesterView = (t: TicketRow, unreadCount: number) => ({
  id: t.id,
  ticketNo: t.ticketNo,
  app: t.app,
  topic: { code: t.topicCode, label: t.topicLabel },
  description: t.description,
  status: t.status,
  tab: DONE.has(t.status) ? 'resolved' : 'open',
  priority: t.priority,
  priorityReason: t.priorityReason,
  team: t.team,
  agent: t.assigneeName === null ? null : { name: t.assigneeName },
  escalationLevel: t.escalationLevel,
  channel: t.channel,
  order: t.orderContext ?? null,
  callbackRequested: t.callbackRequested,
  callbackPhone: maskPhone(t.callbackPhone),
  resolveDueAt: t.resolveDueAt,
  resolvedAt: t.resolvedAt,
  closedAt: t.closedAt,
  awaitingFeedback: t.status === 'RESOLVED' && t.csat === null,
  csat: t.csat,
  lastSeq: t.lastPublicSeq,
  lastMessageAt: t.lastMessageAt,
  lastMessagePreview: t.lastMessagePreview,
  unreadCount,
  version: t.version,
  createdAt: t.createdAt,
});

export type RequesterTicketView = ReturnType<typeof requesterView>;

/** Agent console view (full SLA + requester facts). */
export const agentView = (t: TicketRow) => ({
  ...requesterView(t, 0),
  requester: { id: t.requesterId, type: t.requesterType, name: t.requesterName },
  farmId: t.farmId,
  agent: t.assigneeId === null ? null : { id: t.assigneeId, name: t.assigneeName },
  callbackPhone: t.callbackPhone,
  priorityLocked: t.priorityLocked,
  lastSeq: t.lastSeq,
  unreadCount: undefined,
  sla: {
    policy: t.slaPolicy,
    startedAt: t.slaStartedAt,
    firstResponseDueAt: t.firstResponseDueAt,
    firstRespondedAt: t.firstRespondedAt,
    firstResponseBreachedAt: t.firstResponseBreachedAt,
    resolveDueAt: t.resolveDueAt,
    resolveBreachedAt: t.resolveBreachedAt,
    pausedAt: t.slaPausedAt,
    pausedBusinessMinutes: t.pausedBizMins,
  },
  reopenCount: t.reopenCount,
  csatComment: t.csatComment,
  updatedAt: t.updatedAt,
});

/** Realtime `ticket.updated` payload: safe for requester AND agent sockets. */
export const ticketPulse = (t: TicketRow) => ({
  id: t.id,
  ticketNo: t.ticketNo,
  status: t.status,
  priority: t.priority,
  priorityReason: t.priorityReason,
  team: t.team,
  agent: t.assigneeName === null ? null : { name: t.assigneeName },
  escalationLevel: t.escalationLevel,
  resolveDueAt: t.resolveDueAt,
  awaitingFeedback: t.status === 'RESOLVED' && t.csat === null,
  lastSeq: t.lastPublicSeq,
  lastMessageAt: t.lastMessageAt,
  lastMessagePreview: t.lastMessagePreview,
  version: t.version,
});

/** Requesters never see visibility / internal fields. */
export const publicMessage = (m: MessageView) => ({
  id: m.id,
  ticketId: m.ticketId,
  seq: m.seq,
  senderRole: m.senderRole,
  senderName: m.senderName,
  mine: false,
  kind: m.kind,
  body: m.body,
  attachments: m.attachments,
  card: m.card,
  clientMessageId: m.clientMessageId,
  createdAt: m.createdAt,
});

export const messageFor = (m: MessageView, viewerId: string, agent: boolean) =>
  agent
    ? { ...m, mine: m.senderId === viewerId }
    : { ...publicMessage(m), mine: m.senderId === viewerId };
