import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';

import { RealtimeConnection } from '../connection.js';
import { RealtimeHub } from '../hub.js';
import { parseClientFrame } from '../protocol.js';
import type { ServerFrame } from '../protocol.js';

const logger = { warn: () => undefined } as never;

/** A connection over a fake socket that records what it was sent. */
const fakeConn = (hub: RealtimeHub, tags: string[], opts: { buffered?: number } = {}) => {
  const sent: ServerFrame[] = [];
  const closed: number[] = [];
  const ws = {
    OPEN: 1,
    CLOSED: 3,
    CLOSING: 2,
    readyState: 1,
    bufferedAmount: opts.buffered ?? 0,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerFrame),
    close: (code: number) => {
      closed.push(code);
      ws.readyState = 3;
    },
  };
  const conn = new RealtimeConnection(
    ws as unknown as WebSocket,
    { userId: 'u', userType: 'CUSTOMER', sessionId: 's', app: 'CUSTOMER', tags },
    {
      maxBufferedBytes: 1024,
      maxRooms: 2,
      onJoin: (c, room) => {
        hub.add(c, room);
      },
      onLeave: (c, room) => {
        hub.remove(c, room);
      },
    },
  );
  return { conn, sent, closed };
};

describe('realtime protocol', () => {
  it('parses valid frames and rejects malformed ones', () => {
    expect(parseClientFrame('{"id":"c1","type":"message.send","data":{"a":1}}')).toEqual({
      id: 'c1',
      type: 'message.send',
      data: { a: 1 },
    });
    expect(parseClientFrame('not json')).toBeNull();
    expect(parseClientFrame('[1]')).toBeNull();
    expect(parseClientFrame('{"type":"Bad Type"}')).toBeNull();
    expect(parseClientFrame(`{"type":"ping","id":"${'x'.repeat(65)}"}`)).toBeNull();
  });
});

describe('realtime hub', () => {
  it('delivers by room and audience, skips the sender, and kicks', () => {
    const hub = new RealtimeHub({ redis: () => ({}) as never, channel: 'c', logger });
    const requester = fakeConn(hub, ['requester']);
    const agent = fakeConn(hub, ['agent']);
    requester.conn.join('ticket:1');
    agent.conn.join('ticket:1');

    hub.dispatch({ kind: 'push', room: 'ticket:1', event: 'message.new', data: { n: 1 } });
    hub.dispatch({
      kind: 'push',
      room: 'ticket:1',
      event: 'message.new',
      data: { note: true },
      audience: ['agent'],
    });
    hub.dispatch({
      kind: 'push',
      room: 'ticket:1',
      event: 'typing',
      data: {},
      except: requester.conn.id,
    });

    expect(requester.sent.map((f) => f.type)).toEqual(['message.new']);
    expect(agent.sent.map((f) => f.type)).toEqual(['message.new', 'message.new', 'typing']);

    hub.dispatch({ kind: 'kick', room: 'ticket:1', reason: 'bye', closeCode: 4001 });
    expect(requester.closed).toEqual([4001]);
  });

  it('caps rooms per socket and drops slow consumers', () => {
    const hub = new RealtimeHub({ redis: () => ({}) as never, channel: 'c', logger });
    const c = fakeConn(hub, []);
    expect(c.conn.join('a')).toBe(true);
    expect(c.conn.join('b')).toBe(true);
    expect(c.conn.join('c')).toBe(false);
    const slow = fakeConn(hub, [], { buffered: 4096 });
    slow.conn.push('x', {});
    expect(slow.sent).toEqual([]);
    expect(slow.closed).toEqual([1013]);
  });
});
