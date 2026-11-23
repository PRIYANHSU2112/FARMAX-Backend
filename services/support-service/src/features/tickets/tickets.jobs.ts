import { SUPPORT_EVENTS } from '@farmx/infra/events';
import { userRoom } from '@farmx/infra/realtime';
import type { Cradle } from '@fastify/awilix';

import { emitSupportEvent } from '../../adapters/events.js';
import type { SweptTicket } from './tickets.repository.js';
import { AGENTS_ROOM, ticketRoom } from './tickets.service.js';

const BATCH = 500;

type Deps = Pick<
  Cradle,
  'ticketsRepository' | 'settingsService' | 'runInTransaction' | 'realtimeHub' | 'logger'
>;

/**
 * Background sweeps. Each batch is ONE set-based UPDATE over a partial index, rows taken with
 * FOR UPDATE SKIP LOCKED, so replicas / overlapping ticks never double-fire: a breach or an
 * auto-close is recorded (and its event emitted) exactly once, in the same transaction.
 */
export class TicketsJobs {
  constructor(private readonly deps: Deps) {}

  async sweepSla(): Promise<{ firstResponse: number; resolve: number }> {
    let firstResponse = 0;
    let resolve = 0;
    for (;;) {
      const batch = await this.deps.runInTransaction(async (tx) => {
        const fr = await this.deps.ticketsRepository.breachFirstResponse(tx, BATCH);
        const rs = await this.deps.ticketsRepository.breachResolve(tx, BATCH);
        for (const [kind, rows] of [
          ['FIRST_RESPONSE', fr],
          ['RESOLVE', rs],
        ] as const) {
          for (const t of rows) {
            await this.deps.ticketsRepository.addEvents(tx, t.id, [
              { type: 'SLA_BREACH', to: kind, actorId: null, meta: { dueAt: t.dueAt } },
            ]);
            await emitSupportEvent(
              tx,
              SUPPORT_EVENTS.slaBreached,
              {
                ...ref(t),
                kind,
                priority: t.priority,
                team: t.team,
                assigneeId: t.assigneeId,
                dueAt: new Date(t.dueAt).toISOString(),
              },
              `sla:${t.id}:${kind}`,
            );
          }
        }
        return { fr, rs };
      });
      firstResponse += batch.fr.length;
      resolve += batch.rs.length;
      for (const t of [...batch.fr, ...batch.rs])
        this.deps.realtimeHub.publish(
          AGENTS_ROOM,
          'sla.breached',
          {
            ticketId: t.id,
            ticketNo: t.ticketNo,
            priority: t.priority,
            team: t.team,
            assigneeId: t.assigneeId,
          },
          { audience: ['agent'] },
        );
      if (batch.fr.length < BATCH && batch.rs.length < BATCH) break;
    }
    if (firstResponse + resolve > 0)
      this.deps.logger.info({ firstResponse, resolve }, 'support SLA breaches recorded');
    return { firstResponse, resolve };
  }

  async autoClose(): Promise<{ closed: number }> {
    const { autoCloseHours } = (await this.deps.settingsService.current()).limits;
    let closed = 0;
    for (;;) {
      const rows = await this.deps.runInTransaction(async (tx) => {
        const done = await this.deps.ticketsRepository.autoClose(tx, autoCloseHours, BATCH);
        for (const t of done) {
          await this.deps.ticketsRepository.addEvents(tx, t.id, [
            {
              type: 'STATUS',
              from: 'RESOLVED',
              to: 'CLOSED',
              actorId: null,
              reason: `no feedback for ${String(autoCloseHours)} h`,
            },
          ]);
          await emitSupportEvent(
            tx,
            SUPPORT_EVENTS.ticketStatusChanged,
            { ...ref(t), from: 'RESOLVED', to: 'CLOSED', actorId: null },
            `auto-close:${t.id}`,
          );
        }
        return done;
      });
      closed += rows.length;
      for (const t of rows) {
        const pulse = { id: t.id, ticketNo: t.ticketNo, status: 'CLOSED', awaitingFeedback: false };
        this.deps.realtimeHub.publish(ticketRoom(t.id), 'ticket.updated', pulse);
        this.deps.realtimeHub.publish(userRoom(t.requesterId), 'ticket.updated', pulse);
      }
      if (rows.length < BATCH) break;
    }
    return { closed };
  }
}

const ref = (t: SweptTicket) => ({
  ticketId: t.id,
  ticketNo: t.ticketNo,
  app: t.app,
  requesterId: t.requesterId,
});
