import type { App } from '../../middleware/http.js';
import type { Priority, SlaPolicySnapshot, Team } from '../topics/index.js';

export const STATUSES = ['NEW', 'OPEN', 'WAITING_ON_REQUESTER', 'RESOLVED', 'CLOSED'] as const;
export type TicketStatus = (typeof STATUSES)[number];
export const ACTIVE_STATUSES: readonly TicketStatus[] = ['NEW', 'OPEN', 'WAITING_ON_REQUESTER'];
export const DONE_STATUSES: readonly TicketStatus[] = ['RESOLVED', 'CLOSED'];

export const CHANNELS = ['APP', 'CHAT', 'PHONE', 'EMAIL', 'WHATSAPP'] as const;
export type Channel = (typeof CHANNELS)[number];
export type SenderRole = 'REQUESTER' | 'AGENT' | 'SYSTEM';
export type MessageKind = 'TEXT' | 'SYSTEM' | 'ESCALATION' | 'ACTION_CARD' | 'INTERNAL_NOTE';

/** The full ticket row as services use it. */
export interface TicketRow {
  id: string;
  ticketNo: string;
  app: App;
  requesterId: string;
  requesterType: string;
  requesterName: string | null;
  farmId: string | null;
  topicId: string;
  topicCode: string;
  topicLabel: string;
  description: string;
  priority: Priority;
  priorityReason: string | null;
  priorityLocked: boolean;
  status: TicketStatus;
  team: Team;
  assigneeId: string | null;
  assigneeName: string | null;
  escalationLevel: number;
  channel: Channel;
  orderId: string | null;
  orderContext: unknown;
  callbackRequested: boolean;
  callbackPhone: string | null;
  slaPolicy: unknown;
  slaStartedAt: Date;
  firstResponseDueAt: Date;
  firstRespondedAt: Date | null;
  firstResponseBreachedAt: Date | null;
  resolveDueAt: Date;
  resolveBreachedAt: Date | null;
  slaPausedAt: Date | null;
  pausedBizMins: number;
  resolvedAt: Date | null;
  closedAt: Date | null;
  reopenCount: number;
  csat: 'YES' | 'NOT_YET' | null;
  csatComment: string | null;
  lastSeq: number;
  lastPublicSeq: number;
  lastMessageAt: Date;
  lastMessagePreview: string | null;
  lastSenderRole: SenderRole | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const policyOf = (t: Pick<TicketRow, 'slaPolicy'>): SlaPolicySnapshot => t.slaPolicy as SlaPolicySnapshot;

export interface AttachmentView {
  id: string;
  kind: string;
  mime: string;
  size: number;
  fileName: string | null;
}

export interface MessageView {
  id: string;
  ticketId: string;
  seq: number;
  senderId: string | null;
  senderRole: SenderRole;
  senderName: string | null;
  kind: MessageKind;
  visibility: 'PUBLIC' | 'INTERNAL';
  body: string;
  attachments: AttachmentView[];
  card: unknown;
  clientMessageId: string | null;
  createdAt: Date;
}

/** Action card shown in the chat ("Return RT-26-00418 approved · Refund ₹8,960 · pickup Sat"). */
export interface ActionCard {
  title: string;
  subtitle?: string;
  refType: 'RETURN' | 'REFUND' | 'REPLACEMENT' | 'ORDER' | 'OTHER';
  refId?: string;
  status: 'APPROVED' | 'REJECTED' | 'PENDING' | 'INFO';
}

export interface CreateTicketInput {
  topicCode: string;
  description: string;
  orderId?: string;
  attachments?: string[];
  callbackRequested?: boolean;
  channel?: Channel;
}

export interface MessageInput {
  clientMessageId: string;
  body: string;
  attachments?: string[];
}

export interface AgentMessageInput extends MessageInput {
  kind: 'TEXT' | 'INTERNAL_NOTE' | 'ACTION_CARD';
  card?: ActionCard;
}

export interface TicketListQuery {
  tab: 'open' | 'resolved';
  cursor?: string;
  limit: number;
}

export interface QueueQuery {
  status?: TicketStatus[];
  priority?: Priority[];
  app?: App;
  team?: Team;
  assignee?: 'me' | 'unassigned' | string;
  breached?: boolean;
  q?: string;
  sort: 'priority_sla' | 'recent' | 'oldest';
  cursor?: string;
  limit: number;
}

/** Who is acting on a ticket. */
export interface TicketActor {
  userId: string;
  role: 'REQUESTER' | 'AGENT';
  name: string | null;
  requestId: string | null;
  ip: string | null;
}
