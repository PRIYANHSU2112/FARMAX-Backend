import type { EventEnvelope } from '@farmx/infra/events';
import { describe, expect, it } from 'vitest';

import { EVENT_BINDINGS, RULES } from '../../src/features/events/events.rules.js';

const ref = { ticketId: 't1', ticketNo: 'TK-2026-000001', app: 'VENDOR', requesterId: 'u1' };
const envelope = (type: string, data: object): EventEnvelope => ({
  id: `e-${type}`,
  type,
  version: 1,
  occurredAt: new Date().toISOString(),
  source: 'support-service',
  correlationId: 'c',
  data,
});
const build = (type: string, data: object) => RULES[type]?.build(envelope(type, data), null) ?? [];

describe('support notification rules', () => {
  it('binds every support event', () => {
    for (const t of [
      'support.ticket_created.v1',
      'support.ticket_replied.v1',
      'support.ticket_status_changed.v1',
      'support.ticket_escalated.v1',
      'support.sla_breached.v1',
    ])
      expect(EVENT_BINDINGS).toContain(t);
  });

  it('agent reply → push to the requester in the app the ticket came from', () => {
    const [d] = build('support.ticket_replied.v1', {
      ...ref,
      messageId: 'm1',
      seq: 3,
      agentId: 'a1',
    });
    expect(d).toMatchObject({
      app: 'VENDOR',
      audience: { kind: 'users', userIds: ['u1'] },
      templateKey: 'support.replied',
      dedupeKey: 'support.replied:m1',
    });
  });

  it('only URGENT / HIGH tickets alert the desk; only RESOLVED asks the requester', () => {
    expect(
      build('support.ticket_created.v1', {
        ...ref,
        topicCode: 'X',
        priority: 'MEDIUM',
        team: 'SUPPORT',
        channel: 'APP',
        resolveDueAt: '',
      }),
    ).toEqual([]);
    expect(
      build('support.ticket_created.v1', {
        ...ref,
        topicCode: 'X',
        priority: 'URGENT',
        team: 'SUPPORT',
        channel: 'APP',
        resolveDueAt: '',
      })[0],
    ).toMatchObject({
      app: 'ADMIN',
      priority: 'CRITICAL',
      audience: { kind: 'permission', permission: 'support.manage' },
    });
    expect(
      build('support.ticket_status_changed.v1', {
        ...ref,
        from: 'OPEN',
        to: 'CLOSED',
        actorId: null,
      }),
    ).toEqual([]);
    expect(
      build('support.ticket_status_changed.v1', {
        ...ref,
        from: 'OPEN',
        to: 'RESOLVED',
        actorId: 'a',
      })[0]?.templateKey,
    ).toBe('support.resolved');
  });

  it('SLA breach → assignee, or the whole desk when unassigned; once per clock', () => {
    const assigned = build('support.sla_breached.v1', {
      ...ref,
      kind: 'RESOLVE',
      priority: 'HIGH',
      team: 'SUPPORT',
      assigneeId: 'a1',
      dueAt: '',
    })[0];
    expect(assigned).toMatchObject({
      audience: { kind: 'users', userIds: ['a1'] },
      dedupeKey: 'support.sla:t1:RESOLVE',
    });
    const desk = build('support.sla_breached.v1', {
      ...ref,
      kind: 'FIRST_RESPONSE',
      priority: 'HIGH',
      team: 'SUPPORT',
      assigneeId: null,
      dueAt: '',
    })[0];
    expect(desk?.audience).toEqual({ kind: 'permission', permission: 'support.manage' });
  });

  it('application approved / rejected → push to the applicant with the matching template', () => {
    const data = {
      applicationId: 'ap1',
      applicationType: 'DEALER',
      applicantUserId: 'u9',
      from: 'SUBMITTED',
      actorId: 's1',
    };
    expect(EVENT_BINDINGS).toContain('support.application_status_changed.v1');
    const [approved] = build('support.application_status_changed.v1', { ...data, to: 'APPROVED' });
    expect(approved).toMatchObject({
      app: 'CUSTOMER',
      audience: { kind: 'users', userIds: ['u9'] },
      templateKey: 'support.application_approved',
      vars: { type: 'dealer' },
      entityId: 'ap1',
    });
    const [rejected] = build('support.application_status_changed.v1', { ...data, to: 'REJECTED' });
    expect(rejected?.templateKey).toBe('support.application_rejected');
  });
});
