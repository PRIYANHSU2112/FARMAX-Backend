import type {
  EventEnvelope,
  SupportApplicationStatusChangedV1,
  SupportSlaBreachedV1,
  SupportTicketCreatedV1,
  SupportTicketEscalatedV1,
  SupportTicketRepliedV1,
  SupportTicketStatusChangedV1,
} from '@farmx/infra/events';

import type { NotificationApp } from '../../domain.js';
import type { NotificationDraft } from '../notifications/index.js';
import type { Rule } from './events.rules.js';

/**
 * support-service events → notifications (ids and ticket numbers only; never message text).
 * Requester notifications go to the app the ticket was raised from; staff ones to permission
 * holders in the admin console. Dedupe keys are business keys (message id, event id).
 */
const APPS: readonly NotificationApp[] = ['CUSTOMER', 'VENDOR', 'LOGISTICS', 'WAREHOUSE'];
const appOf = (app: string): NotificationApp =>
  APPS.includes(app as NotificationApp) ? (app as NotificationApp) : 'CUSTOMER';

interface Ref {
  ticketId: string;
  ticketNo: string;
  app: string;
  requesterId: string;
}

const requester = (
  event: EventEnvelope,
  t: Ref,
  d: Pick<NotificationDraft, 'dedupeKey' | 'templateKey' | 'vars'> &
    Partial<Pick<NotificationDraft, 'priority'>>,
): NotificationDraft => ({
  source: 'event',
  sourceEventId: event.id,
  category: 'ACCOUNT',
  priority: 'NORMAL',
  channels: ['PUSH'],
  ...d,
  app: appOf(t.app),
  audience: { kind: 'users', userIds: [t.requesterId] },
  entityType: 'support_ticket',
  entityId: t.ticketId,
  data: { entityType: 'support_ticket', entityId: t.ticketId, ticketNo: t.ticketNo },
});

const staff = (
  event: EventEnvelope,
  t: Ref,
  d: Pick<NotificationDraft, 'dedupeKey' | 'templateKey' | 'vars' | 'priority' | 'audience'>,
): NotificationDraft => ({
  source: 'event',
  sourceEventId: event.id,
  category: 'SYSTEM',
  channels: ['PUSH'],
  ...d,
  app: 'ADMIN',
  entityType: 'support_ticket',
  entityId: t.ticketId,
  data: { entityType: 'support_ticket', entityId: t.ticketId, ticketNo: t.ticketNo },
});

export const SUPPORT_RULES: Readonly<Record<string, Rule>> = {
  /** URGENT / HIGH tickets alert the support desk at once (others wait in the queue). */
  'support.ticket_created.v1': {
    needsOrder: false,
    build: (event) => {
      const d = event.data as SupportTicketCreatedV1;
      if (d.priority !== 'URGENT' && d.priority !== 'HIGH') return [];
      return [
        staff(event, d, {
          dedupeKey: `support.urgent:${d.ticketId}`,
          templateKey: 'support.urgent_ticket',
          priority: d.priority === 'URGENT' ? 'CRITICAL' : 'HIGH',
          audience: { kind: 'permission', permission: 'support.manage' },
          vars: { ticketNo: d.ticketNo, priority: d.priority, topic: d.topicCode },
        }),
      ];
    },
  },
  /** An agent answered: push to the requester (the app also gets it live over the socket). */
  'support.ticket_replied.v1': {
    needsOrder: false,
    build: (event) => {
      const d = event.data as SupportTicketRepliedV1;
      return [
        requester(event, d, {
          dedupeKey: `support.replied:${d.messageId}`,
          templateKey: 'support.replied',
          vars: { ticketNo: d.ticketNo },
        }),
      ];
    },
  },
  /** Resolved → ask "Did this solve your problem?". Other transitions are visible in the app. */
  'support.ticket_status_changed.v1': {
    needsOrder: false,
    build: (event) => {
      const d = event.data as SupportTicketStatusChangedV1;
      if (d.to !== 'RESOLVED') return [];
      return [
        requester(event, d, {
          dedupeKey: `support.resolved:${event.id}`,
          templateKey: 'support.resolved',
          vars: { ticketNo: d.ticketNo },
        }),
      ];
    },
  },
  'support.ticket_escalated.v1': {
    needsOrder: false,
    build: (event) => {
      const d = event.data as SupportTicketEscalatedV1;
      const drafts: NotificationDraft[] = [
        requester(event, d, {
          dedupeKey: `support.escalated:${event.id}`,
          templateKey: 'support.escalated',
          vars: { ticketNo: d.ticketNo, team: d.team.toLowerCase() },
        }),
      ];
      if (d.assigneeId !== null)
        drafts.push(
          staff(event, d, {
            dedupeKey: `support.assigned:${event.id}`,
            templateKey: 'support.assigned',
            priority: 'HIGH',
            audience: { kind: 'users', userIds: [d.assigneeId] },
            vars: { ticketNo: d.ticketNo, level: d.level },
          }),
        );
      return drafts;
    },
  },
  /** Dealer / partner application approved or rejected: push to the applicant (customer app). */
  'support.application_status_changed.v1': {
    needsOrder: false,
    build: (event) => {
      const d = event.data as SupportApplicationStatusChangedV1;
      if (d.to !== 'APPROVED' && d.to !== 'REJECTED') return [];
      return [
        {
          source: 'event',
          sourceEventId: event.id,
          category: 'ACCOUNT',
          priority: 'NORMAL',
          channels: ['PUSH'],
          dedupeKey: `support.application:${event.id}`,
          templateKey:
            d.to === 'APPROVED' ? 'support.application_approved' : 'support.application_rejected',
          vars: { type: d.applicationType.toLowerCase() },
          app: 'CUSTOMER',
          audience: { kind: 'users', userIds: [d.applicantUserId] },
          entityType: 'company_application',
          entityId: d.applicationId,
          data: {
            entityType: 'company_application',
            entityId: d.applicationId,
            status: d.to,
          },
        },
      ];
    },
  },
  /** SLA missed: the assignee (or the whole desk when unassigned). Once per ticket and clock. */
  'support.sla_breached.v1': {
    needsOrder: false,
    build: (event) => {
      const d = event.data as SupportSlaBreachedV1;
      return [
        staff(event, d, {
          dedupeKey: `support.sla:${d.ticketId}:${d.kind}`,
          templateKey: 'support.sla_breached',
          priority: 'HIGH',
          audience:
            d.assigneeId === null
              ? { kind: 'permission', permission: 'support.manage' }
              : { kind: 'users', userIds: [d.assigneeId] },
          vars: {
            ticketNo: d.ticketNo,
            kind: d.kind === 'FIRST_RESPONSE' ? 'first response' : 'resolution',
            priority: d.priority,
          },
        }),
      ];
    },
  },
};
