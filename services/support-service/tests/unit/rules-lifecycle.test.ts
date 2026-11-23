import { describe, expect, it } from 'vitest';

import {
  canTransition,
  loadDelta,
  transitionPatch,
} from '../../src/features/tickets/tickets.lifecycle.js';
import type { TicketRow } from '../../src/features/tickets/tickets.types.js';
import {
  type PriorityRule,
  type TicketFacts,
  decidePriority,
} from '../../src/features/topics/topics.rules.js';

const rule = (o: Partial<PriorityRule>): PriorityRule => ({
  id: o.id ?? 'r',
  app: null,
  topicCode: null,
  conditions: {},
  priority: 'HIGH',
  reasonLabel: 'x',
  team: null,
  ...o,
});
const facts = (o: Partial<TicketFacts> = {}): TicketFacts => ({
  app: 'CUSTOMER',
  topicCode: 'DELIVERY_RETURNS',
  requesterType: 'CUSTOMER',
  text: 'IBD vials felt warm when we opened the box',
  orderAmount: 27821,
  temperatureClasses: ['CC_REF'],
  ...o,
});
const topic = { defaultPriority: 'MEDIUM' as const, team: 'SUPPORT' as const };

describe('dynamic priority', () => {
  it('cold-chain order → HIGH "cold chain"', () => {
    const d = decidePriority(
      [
        rule({
          id: 'cc',
          conditions: { temperatureClasses: ['CC_REF', 'CC_FRZ'] },
          reasonLabel: 'cold chain',
        }),
      ],
      facts(),
      topic,
    );
    expect(d).toEqual({ priority: 'HIGH', reason: 'cold chain', team: 'SUPPORT', ruleId: 'cc' });
  });

  it('first match wins (rules arrive sorted)', () => {
    const d = decidePriority(
      [
        rule({ id: 'mort', conditions: { keywords: ['dead'] }, priority: 'URGENT', team: 'VET' }),
        rule({ id: 'cc', conditions: { temperatureClasses: ['CC_REF'] } }),
      ],
      facts({ text: 'Birds are dead after vaccination' }),
      topic,
    );
    expect(d).toMatchObject({ priority: 'URGENT', team: 'VET', ruleId: 'mort' });
  });

  it('keywords match whole words only, case-insensitive', () => {
    const r = [rule({ conditions: { keywords: ['warm'] } })];
    expect(decidePriority(r, facts({ text: 'They were WARM' }), topic).ruleId).toBe('r');
    expect(decidePriority(r, facts({ text: 'warmly thank you' }), topic).ruleId).toBeNull();
  });

  it('every present condition must hold; app / topic scope', () => {
    const both = [rule({ conditions: { temperatureClasses: ['CC_REF'], minOrderAmount: 50000 } })];
    expect(decidePriority(both, facts(), topic).ruleId).toBeNull();
    expect(decidePriority([rule({ app: 'VENDOR' })], facts(), topic).ruleId).toBeNull();
    expect(decidePriority([rule({ topicCode: 'PAYMENT' })], facts(), topic).ruleId).toBeNull();
    expect(
      decidePriority(
        [rule({ conditions: { minOrderAmount: 10 } })],
        facts({ orderAmount: null }),
        topic,
      ).ruleId,
    ).toBeNull();
  });

  it('no match → topic default', () => {
    expect(decidePriority([], facts(), topic)).toEqual({
      priority: 'MEDIUM',
      reason: null,
      team: 'SUPPORT',
      ruleId: null,
    });
  });
});

const ticket = (o: Partial<TicketRow>): TicketRow =>
  ({
    ticketNo: 'TK-1',
    status: 'OPEN',
    reopenCount: 0,
    slaStartedAt: new Date('2026-12-21T04:30:00Z'),
    firstResponseDueAt: new Date('2026-12-21T05:30:00Z'),
    firstRespondedAt: null,
    resolveDueAt: new Date('2026-12-21T12:30:00Z'),
    slaPausedAt: null,
    pausedBizMins: 0,
    ...o,
  }) as TicketRow;
const policy = {
  calendarId: null,
  firstResponseMins: 60,
  resolveMins: 480,
  businessHoursOnly: false,
};

describe('ticket lifecycle', () => {
  it('enforces who may move a ticket where', () => {
    expect(canTransition('AGENT', 'OPEN', 'WAITING_ON_REQUESTER')).toBe(true);
    expect(canTransition('AGENT', 'CLOSED', 'OPEN')).toBe(false);
    expect(canTransition('REQUESTER', 'OPEN', 'RESOLVED')).toBe(false);
    expect(canTransition('REQUESTER', 'RESOLVED', 'OPEN')).toBe(true);
    expect(canTransition('REQUESTER_MESSAGE', 'NEW', 'OPEN')).toBe(false);
    expect(canTransition('SYSTEM', 'RESOLVED', 'CLOSED')).toBe(true);
    expect(() =>
      transitionPatch(ticket({ status: 'CLOSED' }), 'OPEN', 'AGENT', policy, null, new Date()),
    ).toThrow(/cannot go/);
  });

  it('agent load follows active ↔ done', () => {
    expect(loadDelta('OPEN', 'RESOLVED')).toBe(-1);
    expect(loadDelta('RESOLVED', 'OPEN')).toBe(1);
    expect(loadDelta('OPEN', 'WAITING_ON_REQUESTER')).toBe(0);
    expect(loadDelta('RESOLVED', 'CLOSED')).toBe(0);
  });

  it('waiting pauses; reply resumes; reopen restarts the resolve cycle', () => {
    const now = new Date('2026-12-21T06:30:00Z');
    expect(
      transitionPatch(ticket({}), 'WAITING_ON_REQUESTER', 'AGENT', policy, null, now),
    ).toMatchObject({ slaPausedAt: now });
    const resumed = transitionPatch(
      ticket({ status: 'WAITING_ON_REQUESTER', slaPausedAt: new Date('2026-12-21T05:30:00Z') }),
      'OPEN',
      'REQUESTER_MESSAGE',
      policy,
      null,
      now,
    );
    expect(resumed).toMatchObject({ status: 'OPEN', slaPausedAt: null, pausedBizMins: 60 });
    const reopened = transitionPatch(
      ticket({ status: 'RESOLVED' }),
      'OPEN',
      'REQUESTER',
      policy,
      null,
      now,
    );
    expect(reopened).toMatchObject({
      status: 'OPEN',
      reopenCount: 1,
      resolvedAt: null,
      slaStartedAt: now,
    });
    expect(transitionPatch(ticket({}), 'RESOLVED', 'AGENT', policy, null, now)).toMatchObject({
      resolvedAt: now,
    });
  });
});
