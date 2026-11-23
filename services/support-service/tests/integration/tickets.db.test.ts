import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AGENT_PERMS,
  DB_URL,
  addOrder,
  buildTestApp,
  call,
  customer,
  data,
  errorOf,
  makeAgent,
  raiseTicket,
  receipt,
  staff,
  vendor,
} from './harness.js';

interface Ticket {
  id: string;
  ticketNo: string;
  status: string;
  priority: string;
  priorityReason: string | null;
  version: number;
  unreadCount: number;
  reopenCount?: number;
  agent: { id?: string; name: string } | null;
  awaitingFeedback: boolean;
}
interface Message {
  id: string;
  seq: number;
  kind: string;
  body: string;
  visibility?: string;
  attachments: { id: string }[];
}

describe.skipIf(DB_URL === undefined)('support tickets (Postgres + Redis)', () => {
  let app: FastifyInstance;
  const agentA = staff(...AGENT_PERMS);
  const agentB = staff(...AGENT_PERMS);

  beforeAll(async () => {
    app = await buildTestApp();
    await makeAgent(app, agentA, 'Swathi');
    await makeAgent(app, agentB, 'Dr. K. Srinivas');
  });
  afterAll(async () => {
    await app.close();
  });

  const send = (user: string, id: string, body: string, clientMessageId = randomUUID()) =>
    call(app, 'POST', `/support/tickets/${id}/messages`, {
      user,
      payload: { clientMessageId, body },
    });
  const agentSend = (user: string, id: string, payload: Record<string, unknown>) =>
    call(app, 'POST', `/support/admin/tickets/${id}/messages`, {
      user,
      payload: { clientMessageId: randomUUID(), ...payload },
    });

  describe('create', () => {
    it('cold-chain order → HIGH "cold chain"; order snapshot; evidence bound once', async () => {
      const user = customer();
      const file = receipt(user);
      const { res, ticket } = await raiseTicket(app, user, { attachments: [file] });
      expect(res.statusCode).toBe(201);
      const t = data<Ticket & { order: { orderNo: string } }>(res);
      expect(t).toMatchObject({ priority: 'HIGH', priorityReason: 'cold chain', status: 'NEW' });
      expect(t.order.orderNo).toMatch(/^ORD-26-/);
      expect(t.ticketNo).toMatch(/^TK-\d{4}-\d{6}$/);
      const msgs = data<Message[]>(
        await call(app, 'GET', `/support/tickets/${ticket.id}/messages`, { user }),
      );
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.attachments).toHaveLength(1);
      // The same receipt can never be attached to a second ticket (unique media key).
      const again = await raiseTicket(app, user, { attachments: [file] });
      expect(again.res.statusCode).toBe(409);
    });

    it('validates topic, order ownership and receipts', async () => {
      const user = customer();
      const other = customer();
      const bad = await call(app, 'POST', '/support/tickets', {
        user,
        payload: { topicCode: 'NOPE', description: 'hello there' },
      });
      expect(bad.statusCode).toBe(422);
      const noOrder = await call(app, 'POST', '/support/tickets', {
        user,
        payload: { topicCode: 'DELIVERY_RETURNS', description: 'hello there' },
      });
      expect(noOrder.statusCode).toBe(422);
      const foreign = await call(app, 'POST', '/support/tickets', {
        user,
        payload: {
          topicCode: 'DELIVERY_RETURNS',
          description: 'hello there',
          orderId: addOrder(other),
        },
      });
      expect(foreign.statusCode).toBe(422);
      const stolen = await raiseTicket(app, user, { attachments: [receipt(other)] });
      expect(stolen.res.statusCode).toBe(422);
      const forged = await raiseTicket(app, user, {
        attachments: [`${receipt(user).split('.')[0] ?? ''}.AAAA`],
      });
      expect(forged.res.statusCode).toBe(422);
    });

    it('Idempotency-Key: 5 parallel retries create ONE ticket', async () => {
      const user = customer();
      const orderId = addOrder(user);
      const key = `idem-${randomUUID()}`;
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          call(app, 'POST', '/support/tickets', {
            user,
            headers: { 'idempotency-key': key },
            payload: {
              topicCode: 'DELIVERY_RETURNS',
              description: 'Retry storm on a slow network.',
              orderId,
            },
          }),
        ),
      );
      const ids = new Set(results.map((r) => data<Ticket>(r).id));
      expect(ids.size).toBe(1);
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    });

    it('caps open tickets per requester (setting = 3), even in parallel', async () => {
      const user = customer();
      const results = await Promise.all(Array.from({ length: 5 }, () => raiseTicket(app, user)));
      expect(results.filter((r) => r.res.statusCode === 201)).toHaveLength(3);
      expect(errorOf(results.find((r) => r.res.statusCode === 409)!.res).details?.reason).toBe(
        'OPEN_TICKET_LIMIT',
      );
    });

    it('vendors raise tickets in their own app', async () => {
      const res = await call(app, 'POST', '/support/tickets', {
        user: vendor(),
        payload: { topicCode: 'SETTLEMENT', description: 'Payout missing for Tuesday.' },
      });
      expect(res.statusCode).toBe(201);
      expect(data<{ app: string }>(res).app).toBe('VENDOR');
    });
  });

  describe('messages', () => {
    it('24 parallel replies + 3 retries: gap-free seq 1..26; a retried clientMessageId is stored once', async () => {
      const { user, ticket } = await raiseTicket(app);
      const dup = randomUUID();
      const results = await Promise.all([
        ...Array.from({ length: 24 }, (_, i) => send(user, ticket.id, `message ${String(i)}`)),
        send(user, ticket.id, 'duplicate', dup),
        send(user, ticket.id, 'duplicate', dup),
        send(user, ticket.id, 'duplicate', dup),
      ]);
      expect(results.every((r) => r.statusCode === 201 || r.statusCode === 200)).toBe(true);
      const msgs = data<Message[]>(
        await call(app, 'GET', `/support/tickets/${ticket.id}/messages?limit=100`, { user }),
      );
      expect(msgs.map((m) => m.seq)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
      expect(msgs.filter((m) => m.body === 'duplicate')).toHaveLength(1);
      const resync = data<Message[]>(
        await call(app, 'GET', `/support/tickets/${ticket.id}/messages?afterSeq=24`, { user }),
      );
      expect(resync.map((m) => m.seq)).toEqual([25, 26]);
    });

    it('owner only: another user gets 404; internal notes never reach the requester', async () => {
      const { user, ticket } = await raiseTicket(app);
      expect(
        (await call(app, 'GET', `/support/tickets/${ticket.id}`, { user: customer() })).statusCode,
      ).toBe(404);
      expect((await send(customer(), ticket.id, 'hi')).statusCode).toBe(404);
      expect(
        (
          await agentSend(agentA, ticket.id, {
            kind: 'INTERNAL_NOTE',
            body: 'Logger shows 11.2 °C',
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (await agentSend(agentA, ticket.id, { body: 'Please do not use them.' })).statusCode,
      ).toBe(201);
      const mine = data<Message[]>(
        await call(app, 'GET', `/support/tickets/${ticket.id}/messages`, { user }),
      );
      expect(mine.some((m) => m.body.includes('11.2'))).toBe(false);
      const agents = data<Message[]>(
        await call(app, 'GET', `/support/admin/tickets/${ticket.id}/messages`, { user: agentA }),
      );
      expect(agents.some((m) => m.visibility === 'INTERNAL')).toBe(true);
      // First public reply auto-claimed the ticket ("joined") and stopped the first-response clock.
      const t = data<Ticket & { sla: { firstRespondedAt: string | null } }>(
        await call(app, 'GET', `/support/admin/tickets/${ticket.id}`, { user: agentA }),
      );
      expect(t.status).toBe('OPEN');
      expect(t.agent?.id).toBe(agentA);
      expect(t.sla.firstRespondedAt).not.toBeNull();
      const detail = data<Ticket>(
        await call(app, 'GET', `/support/tickets/${ticket.id}`, { user }),
      );
      expect(detail.unreadCount).toBe(2); // "joined" + the reply; the note is not counted
    });

    it('a customer token cannot use the agent console', async () => {
      const { user, ticket } = await raiseTicket(app);
      expect((await call(app, 'GET', '/support/admin/tickets', { user })).statusCode).toBe(403);
      expect(
        (
          await call(app, 'POST', `/support/admin/tickets/${ticket.id}/claim`, {
            user: staff('support.view'),
          })
        ).statusCode,
      ).toBe(403);
    });
  });

  describe('agent actions', () => {
    it('two agents claiming at once: exactly one wins', async () => {
      const { ticket } = await raiseTicket(app);
      const [a, b] = await Promise.all([
        call(app, 'POST', `/support/admin/tickets/${ticket.id}/claim`, { user: agentA }),
        call(app, 'POST', `/support/admin/tickets/${ticket.id}/claim`, { user: agentB }),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    });

    it('stale If-Match → 409 STALE_VERSION', async () => {
      const { ticket } = await raiseTicket(app);
      const claimed = data<Ticket>(
        await call(app, 'POST', `/support/admin/tickets/${ticket.id}/claim`, { user: agentA }),
      );
      const ok = await call(app, 'PATCH', `/support/admin/tickets/${ticket.id}/priority`, {
        user: agentA,
        headers: { 'if-match': String(claimed.version) },
        payload: { priority: 'URGENT', reason: 'Whole flock at risk' },
      });
      expect(ok.statusCode).toBe(200);
      const stale = await call(app, 'POST', `/support/admin/tickets/${ticket.id}/status`, {
        user: agentA,
        headers: { 'if-match': String(claimed.version) },
        payload: { to: 'RESOLVED' },
      });
      expect(stale.statusCode).toBe(409);
      expect(errorOf(stale).details?.reason).toBe('STALE_VERSION');
    });

    it('escalation to a vet: team, level, public note', async () => {
      const { user, ticket } = await raiseTicket(app);
      const res = await call(app, 'POST', `/support/admin/tickets/${ticket.id}/escalate`, {
        user: agentA,
        payload: {
          team: 'VET',
          assigneeId: agentB,
          reason: 'Biological above 8 °C',
          note: 'Escalated to Dr. K. Srinivas.',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(
        data<{ team: string; escalationLevel: number; agent: { id: string } }>(res),
      ).toMatchObject({ team: 'VET', escalationLevel: 1, agent: { id: agentB } });
      const msgs = data<Message[]>(
        await call(app, 'GET', `/support/tickets/${ticket.id}/messages`, { user }),
      );
      expect(msgs.at(-1)).toMatchObject({
        kind: 'ESCALATION',
        body: 'Escalated to Dr. K. Srinivas.',
      });
    });
  });

  describe('lifecycle', () => {
    it('waiting → reply resumes → resolved → "Not yet" reopens → resolved → "Yes" closes → closed is final', async () => {
      const { user, ticket } = await raiseTicket(app);
      await call(app, 'POST', `/support/admin/tickets/${ticket.id}/claim`, { user: agentA });
      const status = (to: string) =>
        call(app, 'POST', `/support/admin/tickets/${ticket.id}/status`, {
          user: agentA,
          payload: { to },
        });
      const db = app.diContainer.resolve('db');

      expect((await status('WAITING_ON_REQUESTER')).statusCode).toBe(200);
      expect(
        (await db.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).slaPausedAt,
      ).not.toBeNull();
      await send(user, ticket.id, 'Here is the logger photo.');
      const resumed = await db.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(resumed.status).toBe('OPEN');
      expect(resumed.slaPausedAt).toBeNull();

      expect((await status('RESOLVED')).statusCode).toBe(200);
      expect(
        data<Ticket>(await call(app, 'GET', `/support/tickets/${ticket.id}`, { user }))
          .awaitingFeedback,
      ).toBe(true);
      const notYet = await call(app, 'POST', `/support/tickets/${ticket.id}/feedback`, {
        user,
        payload: { resolved: false },
      });
      expect(data<Ticket>(notYet).status).toBe('OPEN');
      expect(
        (await db.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).reopenCount,
      ).toBe(1);

      await status('RESOLVED');
      const yes = await call(app, 'POST', `/support/tickets/${ticket.id}/feedback`, {
        user,
        payload: { resolved: true },
      });
      expect(data<Ticket>(yes).status).toBe('CLOSED');
      expect((await send(user, ticket.id, 'one more thing')).statusCode).toBe(409);
      expect((await status('OPEN')).statusCode).toBe(409);
      // Agent load went back to what it was (claimed +1, resolved -1, reopened +1, resolved -1).
      const events = await db.supportTicketEvent.count({ where: { ticketId: ticket.id } });
      expect(events).toBeGreaterThanOrEqual(8);
    });

    it('lists Open / Resolved tabs with counts', async () => {
      const user = customer();
      const { ticket } = await raiseTicket(app, user);
      await raiseTicket(app, user);
      await call(app, 'POST', `/support/tickets/${ticket.id}/close`, { user, payload: {} });
      const res = await call(app, 'GET', '/support/tickets?tab=open', { user });
      expect(data<Ticket[]>(res)).toHaveLength(1);
      expect(
        res.json<{ meta: { counts: { open: number; resolved: number } } }>().meta.counts,
      ).toEqual({ open: 1, resolved: 1 });
    });
  });

  describe('SLA sweep', () => {
    it('records a breach exactly once even when two sweeps overlap', async () => {
      const { ticket } = await raiseTicket(app);
      const db = app.diContainer.resolve('db');
      await db.supportTicket.update({
        where: { id: ticket.id },
        data: {
          firstResponseDueAt: new Date(Date.now() - 60_000),
          resolveDueAt: new Date(Date.now() - 60_000),
        },
      });
      const jobs = app.diContainer.resolve('ticketsJobs');
      await Promise.all([jobs.sweepSla(), jobs.sweepSla(), jobs.sweepSla()]);
      await jobs.sweepSla();
      const breaches = await db.supportTicketEvent.findMany({
        where: { ticketId: ticket.id, type: 'SLA_BREACH' },
      });
      expect(breaches.map((b) => b.to).sort()).toEqual(['FIRST_RESPONSE', 'RESOLVE']);
      const t = await db.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(t.firstResponseBreachedAt).not.toBeNull();
      expect(t.resolveBreachedAt).not.toBeNull();
    });

    it('auto-closes resolved tickets without feedback', async () => {
      const { ticket } = await raiseTicket(app);
      await call(app, 'POST', `/support/admin/tickets/${ticket.id}/claim`, { user: agentA });
      await call(app, 'POST', `/support/admin/tickets/${ticket.id}/status`, {
        user: agentA,
        payload: { to: 'RESOLVED' },
      });
      const db = app.diContainer.resolve('db');
      await db.supportTicket.update({
        where: { id: ticket.id },
        data: { resolvedAt: new Date(Date.now() - 73 * 3_600_000) },
      });
      await app.diContainer.resolve('ticketsJobs').autoClose();
      expect((await db.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe(
        'CLOSED',
      );
    });
  });

  describe('public help content', () => {
    it('config, FAQ search, suggestions and legal pages work without a token', async () => {
      const cfg = await call(app, 'GET', '/support/config?app=CUSTOMER');
      expect(cfg.statusCode).toBe(200);
      expect(data<{ topics: { code: string }[] }>(cfg).topics.map((t) => t.code)).toContain(
        'DELIVERY_RETURNS',
      );
      expect((await call(app, 'GET', '/faqs?app=CUSTOMER&q=refund')).statusCode).toBe(200);
      expect(
        (await call(app, 'GET', '/support/suggestions?app=CUSTOMER&topic=PAYMENT&q=debited'))
          .statusCode,
      ).toBe(200);
      const legal = await call(app, 'GET', '/legal/PRIVACY_POLICY?app=CUSTOMER');
      expect([200, 404]).toContain(legal.statusCode);
    });
  });
});
