import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
  AGENT_PERMS,
  DB_URL,
  ORIGIN,
  buildTestApp,
  call,
  customer,
  data,
  makeAgent,
  raiseTicket,
  staff,
} from './harness.js';

interface Frame {
  type: string;
  id?: string;
  room?: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

/** A test client: collects frames, sends with ids, awaits replies / pushes. */
class Client {
  readonly frames: Frame[] = [];
  private seq = 0;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw: WebSocket.RawData) => {
      // Default binaryType is 'nodebuffer': every text frame arrives as one Buffer.
      this.frames.push(JSON.parse((raw as Buffer).toString('utf8')) as Frame);
    });
  }

  static open(url: string, origin?: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, origin === undefined ? {} : { origin });
      ws.once('open', () => {
        resolve(new Client(ws));
      });
      ws.once('unexpected-response', (_req, res) => {
        reject(new Error(`HTTP ${String(res.statusCode)}`));
      });
      ws.once('error', reject);
    });
  }

  async request(type: string, payload?: unknown): Promise<Frame> {
    const id = `c${String((this.seq += 1))}`;
    this.ws.send(JSON.stringify({ id, type, ...(payload === undefined ? {} : { data: payload }) }));
    return this.waitFor((f) => f.id === id);
  }

  async waitFor(match: (f: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const started = Date.now();
    for (;;) {
      const found = this.frames.find(match);
      if (found !== undefined) return found;
      if (Date.now() - started > timeoutMs)
        throw new Error(`timeout; frames: ${JSON.stringify(this.frames.map((f) => f.type))}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  closed(): Promise<number> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) resolve(-1);
      this.ws.once('close', (code: number) => {
        resolve(code);
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

describe.skipIf(DB_URL === undefined)('support live chat over WebSocket', () => {
  let app: FastifyInstance;
  let base: string;
  const agent = staff(...AGENT_PERMS);

  const token = async (user: string, as: 'requester' | 'agent' = 'requester') =>
    data<{ token: string }>(
      await call(app, 'POST', '/support/chat/ws-token', { user, payload: { as } }),
    ).token;
  const connect = async (user: string, as: 'requester' | 'agent' = 'requester') =>
    Client.open(`${base}/support/chat/ws?token=${await token(user, as)}`, ORIGIN);

  beforeAll(async () => {
    app = await buildTestApp();
    await makeAgent(app, agent, 'Swathi');
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    base = `ws://127.0.0.1:${String(address.port)}`;
  });
  afterAll(async () => {
    await app.close();
  });

  it('refuses a missing, reused or foreign-audience token and a bad Origin', async () => {
    const user = customer();
    await expect(Client.open(`${base}/support/chat/ws?token=nope`, ORIGIN)).rejects.toThrow(
      'HTTP 401',
    );
    const t = await token(user);
    await expect(
      Client.open(`${base}/support/chat/ws?token=${t}`, 'http://evil.test'),
    ).rejects.toThrow('HTTP 403');
    const ok = await Client.open(`${base}/support/chat/ws?token=${t}`, ORIGIN); // origin check runs first: token unused
    await expect(Client.open(`${base}/support/chat/ws?token=${t}`, ORIGIN)).rejects.toThrow(
      'HTTP 401',
    ); // single use
    ok.close();
    expect(
      (
        await call(app, 'POST', '/support/chat/ws-token', {
          user: customer(),
          payload: { as: 'agent' },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('requester ⇄ agent live: subscribe, send, ack, fan-out, typing, internal notes stay with agents', async () => {
    const { user, ticket } = await raiseTicket(app);
    const me = await connect(user);
    const desk = await connect(agent, 'agent');
    await me.waitFor((f) => f.type === 'ready');

    const sub = await me.request('subscribe', { ticketId: ticket.id, afterSeq: 0 });
    expect(sub.type).toBe('ack');
    expect((sub.data?.messages as unknown[]).length).toBe(1);
    expect((await desk.request('subscribe', { ticketId: ticket.id })).type).toBe('ack');
    expect((await desk.request('queue.subscribe')).type).toBe('ack');

    const clientMessageId = randomUUID();
    const sent = await me.request('message.send', {
      ticketId: ticket.id,
      clientMessageId,
      body: 'Are they safe to use?',
    });
    expect(sent.type).toBe('ack');
    expect((sent.data?.message as { seq: number }).seq).toBe(2);
    const replay = await me.request('message.send', {
      ticketId: ticket.id,
      clientMessageId,
      body: 'Are they safe to use?',
    });
    expect(replay.data?.replayed).toBe(true);
    await desk.waitFor(
      (f) =>
        f.type === 'message.new' && (f.data as { body?: string }).body === 'Are they safe to use?',
    );
    await desk.waitFor((f) => f.type === 'queue.updated');

    await desk.request('typing', { ticketId: ticket.id });
    await me.waitFor((f) => f.type === 'typing');

    await call(app, 'POST', `/support/admin/tickets/${ticket.id}/messages`, {
      user: agent,
      payload: { clientMessageId: randomUUID(), kind: 'INTERNAL_NOTE', body: 'SECRET logger 11.2' },
    });
    await call(app, 'POST', `/support/admin/tickets/${ticket.id}/messages`, {
      user: agent,
      payload: { clientMessageId: randomUUID(), body: 'Please do not use them.' },
    });
    await me.waitFor(
      (f) =>
        f.type === 'message.new' &&
        (f.data as { body?: string }).body === 'Please do not use them.',
    );
    await desk.waitFor(
      (f) =>
        f.type === 'message.new' && (f.data as { body?: string }).body === 'SECRET logger 11.2',
    );
    expect(me.frames.some((f) => JSON.stringify(f).includes('SECRET'))).toBe(false);

    const read = await me.request('read', { ticketId: ticket.id, seq: 99 });
    expect(read.type).toBe('ack');
    me.close();
    desk.close();
  });

  it('access is checked on every frame: another user cannot subscribe or send', async () => {
    const { ticket } = await raiseTicket(app);
    const intruder = await connect(customer());
    const sub = await intruder.request('subscribe', { ticketId: ticket.id });
    expect(sub).toMatchObject({ type: 'error', error: { code: 'NOT_FOUND' } });
    const send = await intruder.request('message.send', {
      ticketId: ticket.id,
      clientMessageId: randomUUID(),
      body: 'hi',
    });
    expect(send.type).toBe('error');
    const typing = await intruder.request('typing', { ticketId: ticket.id });
    expect(typing).toMatchObject({ type: 'error', error: { code: 'FORBIDDEN' } });
    const bad = await intruder.request('subscribe', { ticketId: 'not-a-uuid' });
    expect(bad).toMatchObject({ type: 'error', error: { code: 'VALIDATION_ERROR' } });
    intruder.close();
  });

  it('closes on an oversized frame (1009) and on a session revocation (4001)', async () => {
    const big = await connect(customer());
    const closedBig = big.closed();
    big.ws.send(JSON.stringify({ type: 'ping', data: 'x'.repeat(20_000) }));
    expect(await closedBig).toBe(1009);

    const user = customer();
    const c = await connect(user);
    const closed = c.closed();
    app.diContainer.resolve('realtimeHub').kickUser(user, 'account deleted');
    expect(await closed).toBe(4001);
  });

  it('a plain GET on the socket path answers 426', async () => {
    expect((await call(app, 'GET', '/support/chat/ws')).statusCode).toBe(426);
  });
});
