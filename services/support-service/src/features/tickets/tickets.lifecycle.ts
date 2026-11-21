import { ConflictError } from '@farmx/common/errors';

import {
  type BusinessCalendar,
  type SlaPolicySnapshot,
  pauseClock,
  restartResolveClock,
  resumeClock,
} from '../topics/index.js';
import { ACTIVE_STATUSES, type TicketRow, type TicketStatus } from './tickets.types.js';

export type TransitionBy = 'AGENT' | 'REQUESTER' | 'REQUESTER_MESSAGE' | 'SYSTEM';

/** Explicit state machine: who may move a ticket from → to. */
const ALLOWED: Record<TransitionBy, Partial<Record<TicketStatus, readonly TicketStatus[]>>> = {
  AGENT: {
    NEW: ['OPEN', 'RESOLVED', 'CLOSED'],
    OPEN: ['WAITING_ON_REQUESTER', 'RESOLVED', 'CLOSED'],
    WAITING_ON_REQUESTER: ['OPEN', 'RESOLVED', 'CLOSED'],
    RESOLVED: ['OPEN', 'CLOSED'],
  },
  REQUESTER: {
    NEW: ['CLOSED'],
    OPEN: ['CLOSED'],
    WAITING_ON_REQUESTER: ['CLOSED'],
    RESOLVED: ['CLOSED', 'OPEN'],
  },
  /** A requester reply wakes a waiting ticket and reopens a resolved one. */
  REQUESTER_MESSAGE: { WAITING_ON_REQUESTER: ['OPEN'], RESOLVED: ['OPEN'] },
  SYSTEM: { RESOLVED: ['CLOSED'] },
};

export const canTransition = (by: TransitionBy, from: TicketStatus, to: TicketStatus): boolean =>
  ALLOWED[by][from]?.includes(to) ?? false;

export const isActive = (s: TicketStatus): boolean => ACTIVE_STATUSES.includes(s);

/** Change of the assignee's open-ticket load caused by a status change. */
export const loadDelta = (from: TicketStatus, to: TicketStatus): number =>
  Number(isActive(to)) - Number(isActive(from));

/**
 * The column patch of one transition, including its SLA side effects:
 *   → WAITING  pauses the resolve clock      WAITING →  resumes it (paused minutes extend the due)
 *   RESOLVED → OPEN  reopen: new resolve cycle, reopenCount + 1, feedback cleared
 *   → RESOLVED / CLOSED  timestamps
 * Throws 409 when the transition is not allowed for `by`.
 */
export function transitionPatch(
  t: TicketRow,
  to: TicketStatus,
  by: TransitionBy,
  policy: SlaPolicySnapshot,
  cal: BusinessCalendar | null,
  now: Date,
): Record<string, unknown> {
  if (!canTransition(by, t.status, to))
    throw new ConflictError(`Ticket ${t.ticketNo} cannot go from ${t.status} to ${to}`, {
      details: { reason: 'INVALID_TRANSITION', from: t.status, to },
    });
  const patch: Record<string, unknown> = { status: to };
  if (to === 'WAITING_ON_REQUESTER') Object.assign(patch, pauseClock(t, now));
  if (t.status === 'WAITING_ON_REQUESTER') Object.assign(patch, resumeClock(t, policy, cal, now));
  if (t.status === 'RESOLVED' && to === 'OPEN')
    Object.assign(patch, restartResolveClock(policy, cal, now), {
      reopenCount: t.reopenCount + 1,
      resolvedAt: null,
      csat: null,
      csatComment: null,
    });
  if (to === 'RESOLVED') patch.resolvedAt = now;
  if (to === 'CLOSED') patch.closedAt = now;
  return patch;
}
