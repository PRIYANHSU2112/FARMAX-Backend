/**
 * Event contracts PUBLISHED by support-service. Ids, codes and states only — never message text,
 * phone numbers or other PII. Consumers: notification-service (push / in-app to the requester,
 * alerts to agents).
 */
export const SUPPORT_EVENT_SOURCE = 'support-service';

export const SUPPORT_EVENTS = {
  ticketCreated: 'support.ticket_created.v1',
  ticketReplied: 'support.ticket_replied.v1',
  ticketStatusChanged: 'support.ticket_status_changed.v1',
  ticketEscalated: 'support.ticket_escalated.v1',
  slaBreached: 'support.sla_breached.v1',
} as const;

export type SupportEventType = (typeof SUPPORT_EVENTS)[keyof typeof SUPPORT_EVENTS];

interface TicketRef {
  ticketId: string;
  ticketNo: string;
  /** CUSTOMER · VENDOR · LOGISTICS · WAREHOUSE */
  app: string;
  requesterId: string;
}

export interface SupportTicketCreatedV1 extends TicketRef {
  topicCode: string;
  /** URGENT · HIGH · MEDIUM · LOW */
  priority: string;
  team: string;
  channel: string;
  resolveDueAt: string;
}

/** An agent posted a PUBLIC reply (internal notes never emit). */
export interface SupportTicketRepliedV1 extends TicketRef {
  messageId: string;
  seq: number;
  agentId: string;
}

export interface SupportTicketStatusChangedV1 extends TicketRef {
  from: string;
  to: string;
  actorId: string | null;
}

export interface SupportTicketEscalatedV1 extends TicketRef {
  team: string;
  level: number;
  assigneeId: string | null;
  actorId: string;
}

/** Emitted once per ticket and kind (first response / resolution). */
export interface SupportSlaBreachedV1 extends TicketRef {
  kind: 'FIRST_RESPONSE' | 'RESOLVE';
  priority: string;
  team: string;
  assigneeId: string | null;
  dueAt: string;
}

export interface SupportEventMap {
  'support.ticket_created.v1': SupportTicketCreatedV1;
  'support.ticket_replied.v1': SupportTicketRepliedV1;
  'support.ticket_status_changed.v1': SupportTicketStatusChangedV1;
  'support.ticket_escalated.v1': SupportTicketEscalatedV1;
  'support.sla_breached.v1': SupportSlaBreachedV1;
}
