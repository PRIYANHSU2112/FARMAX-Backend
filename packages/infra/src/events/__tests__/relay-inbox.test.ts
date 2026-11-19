import { describe, expect, it, vi } from 'vitest';

import type { EventEnvelope } from '../envelope.js';
import { OutboxRelay, PoisonMessageError, createInbox, parseEnvelope } from '../index.js';
import { settle } from '../rabbitmq.js';

describe('consumer settle policy', () => {
  it('acks success, retries transient errors, dead-letters poison and exhausted', () => {
    expect(settle(undefined, 0, 5)).toBe('ack');
    expect(settle(new Error('db down'), 0, 5)).toBe('retry');
    expect(settle(new Error('db down'), 4, 5)).toBe('dead-letter');
    expect(settle(new PoisonMessageError('bad'), 0, 5)).toBe('dead-letter');
  });
});

const envelope = (id: string, type = 'product.published.v1'): EventEnvelope => ({
  id,
  type,
  version: 1,
  occurredAt: '2026-11-14T00:00:00.000Z',
  source: 'product-service',
  correlationId: 'req-1',
  data: {},
});

const logger = { warn: vi.fn(), error: vi.fn() };

describe('OutboxRelay', () => {
  it('publishes every claimed row and reports per-row outcomes', async () => {
    let outcomes: unknown;
    const source = {
      drain: vi.fn(async (_limit: number, publish: (rows: never[]) => Promise<unknown>) => {
        outcomes = await publish([
          { id: 'a', type: 'x.y.v1', payload: envelope('a') },
          { id: 'b', type: 'x.y.v1', payload: envelope('b') },
        ] as never[]);
        return 2;
      }),
    };
    const publisher = {
      publish: vi.fn((e: EventEnvelope) =>
        e.id === 'b' ? Promise.reject(new Error('nack')) : Promise.resolve(),
      ),
    };
    const relay = new OutboxRelay({ source, publisher, logger, batchSize: 10 });
    expect(await relay.tick()).toBe(2);
    expect(outcomes).toEqual([
      { id: 'a', ok: true },
      { id: 'b', ok: false, error: 'nack' },
    ]);
    expect(source.drain).toHaveBeenCalledWith(10, expect.any(Function));
  });

  it('start/stop is safe to call repeatedly', async () => {
    const relay = new OutboxRelay({
      source: { drain: () => Promise.resolve(0) },
      publisher: { publish: () => Promise.resolve() },
      logger,
      idleMs: 5,
    });
    relay.start();
    relay.start();
    await new Promise((r) => setTimeout(r, 20));
    await relay.stop();
    await relay.stop();
  });
});

describe('inbox', () => {
  const run = <T>(work: (tx: object) => Promise<T>) => work({});

  it('processes once, then reports duplicates; unknown types are ignored', async () => {
    const seen = new Set<string>();
    const handler = vi.fn(() => Promise.resolve());
    const inbox = createInbox({
      consumer: 'test',
      runInTransaction: run,
      claim: (_tx, id) => {
        if (seen.has(id)) return Promise.resolve(false);
        seen.add(id);
        return Promise.resolve(true);
      },
      handlers: { 'product.published.v1': handler },
    });
    expect(await inbox(envelope('1'))).toBe('processed');
    expect(await inbox(envelope('1'))).toBe('duplicate');
    expect(await inbox(envelope('2', 'other.thing.v1'))).toBe('ignored');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a failing handler propagates (transaction rolls back, message retried)', async () => {
    const inbox = createInbox({
      consumer: 'test',
      runInTransaction: run,
      claim: () => Promise.resolve(true),
      handlers: { 'product.published.v1': () => Promise.reject(new Error('boom')) },
    });
    await expect(inbox(envelope('3'))).rejects.toThrow('boom');
  });

  it('parseEnvelope rejects poison messages', () => {
    expect(parseEnvelope(JSON.stringify(envelope('4'))).id).toBe('4');
    expect(() => parseEnvelope('not json')).toThrow(PoisonMessageError);
    expect(() => parseEnvelope('{"id":"x","type":"Bad"}')).toThrow(PoisonMessageError);
  });
});
