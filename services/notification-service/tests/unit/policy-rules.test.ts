import type { EventEnvelope } from '@farmx/infra/events';
import { describe, expect, it } from 'vitest';

import { RULES } from '../../src/features/events/events.rules.js';
import { allowedChannels } from '../../src/features/preferences/preferences.policy.js';
import type { ExternalChannel } from '../../src/features/templates/templates.types.js';

const ALL: ExternalChannel[] = ['PUSH', 'EMAIL', 'SMS'];
const prefs = (entries: [ExternalChannel, boolean][]) => new Map(entries);

describe('delivery policy', () => {
  it('opt-out categories: on by default, off when the user disabled the channel', () => {
    expect(allowedChannels(ALL, 'ORDER', 'NORMAL', prefs([]))).toEqual(['PUSH', 'EMAIL']);
    expect(allowedChannels(ALL, 'ORDER', 'HIGH', prefs([['EMAIL', false]]))).toEqual([
      'PUSH',
      'SMS',
    ]);
  });

  it('PROMO is opt-in', () => {
    expect(allowedChannels(ALL, 'PROMO', 'NORMAL', prefs([]))).toEqual([]);
    expect(allowedChannels(ALL, 'PROMO', 'NORMAL', prefs([['PUSH', true]]))).toEqual(['PUSH']);
  });

  it('SECURITY and CRITICAL ignore opt-outs; SMS only for HIGH / CRITICAL', () => {
    const off = prefs([
      ['PUSH', false],
      ['EMAIL', false],
      ['SMS', false],
    ]);
    expect(allowedChannels(ALL, 'SECURITY', 'HIGH', off)).toEqual(ALL);
    expect(allowedChannels(ALL, 'ORDER', 'CRITICAL', off)).toEqual(ALL);
    expect(allowedChannels(ALL, 'SECURITY', 'NORMAL', off)).toEqual(['PUSH', 'EMAIL']);
  });
});

const ORDER = { orderId: 'o1', orderNo: 'ORD-1', userId: 'u1' };
const event = (type: string, data: object, id = 'e1'): EventEnvelope => ({
  id,
  type,
  version: 1,
  occurredAt: '2026-11-19T00:00:00Z',
  source: 'test',
  correlationId: 'c',
  data,
});
const build = (type: string, data: object, id?: string) =>
  RULES[type]?.build(event(type, data, id), ORDER) ?? [];

describe('event rules', () => {
  it('buyer events target the order owner in the customer app with an order deep link', () => {
    const [d] = build('payment.captured.v1', {
      paymentId: 'p1',
      orderId: 'o1',
      orderNo: 'ORD-1',
      amountPaise: 2_782_150,
    });
    expect(d).toMatchObject({
      dedupeKey: 'payment.captured:p1',
      app: 'CUSTOMER',
      audience: { kind: 'users', userIds: ['u1'] },
      channels: ['PUSH', 'EMAIL'],
      vars: { orderNo: 'ORD-1', amount: 27_821.5 },
      data: { entityType: 'order', entityId: 'o1', orderNo: 'ORD-1' },
      source: 'event',
      sourceEventId: 'e1',
    });
  });

  it('dedupe keys are business keys (recovery resends with a new event id collapse)', () => {
    const release = { orderId: 'o1', orderNo: 'ORD-1', scope: 'FULL', lines: [], reasonCode: 'X' };
    expect(build('order.rejected.v1', release, 'a')[0]?.dedupeKey).toBe(
      build('order.rejected.v1', release, 'b')[0]?.dedupeKey,
    );
    const partial = (lines: { variantId: string; qty: number }[], id: string) =>
      build('order.cancelled.v1', { ...release, scope: 'PARTIAL', lines }, id)[0];
    const a = partial(
      [
        { variantId: 'v1', qty: 1 },
        { variantId: 'v2', qty: 2 },
      ],
      'a',
    );
    const b = partial(
      [
        { variantId: 'v2', qty: 2 },
        { variantId: 'v1', qty: 1 },
      ],
      'b',
    );
    const c = partial([{ variantId: 'v3', qty: 1 }], 'c');
    expect(a?.templateKey).toBe('order.partially_cancelled');
    expect(a?.dedupeKey).toBe(b?.dedupeKey);
    expect(a?.dedupeKey).not.toBe(c?.dedupeKey);
  });

  it('order.failed: maps the reason; ORDER_CLOSED resends notify nobody', () => {
    const failed = { orderId: 'o1', orderNo: 'ORD-1', scope: 'FULL', lines: [] };
    expect(
      build('order.failed.v1', { ...failed, reasonCode: 'PAYMENT_NOT_COMPLETED' })[0],
    ).toMatchObject({
      priority: 'HIGH',
      channels: ['PUSH', 'EMAIL', 'SMS'],
      vars: { reason: 'payment was not completed in time' },
    });
    expect(build('order.failed.v1', { ...failed, reasonCode: 'ORDER_CLOSED' })).toEqual([]);
  });

  it('staff events target permission holders (warehouse-scoped low stock)', () => {
    expect(
      build('inventory.low_stock.v1', {
        variantId: 'v',
        warehouseId: 'w',
        availableQty: 3,
        threshold: 5,
      })[0],
    ).toMatchObject({
      app: 'WAREHOUSE',
      audience: { kind: 'permission', permission: 'inventory.view', warehouseId: 'w' },
      data: { entityType: 'variant', entityId: 'v', warehouseId: 'w' },
    });
    expect(
      build('order.review_overdue.v1', { orderId: 'o1', orderNo: 'ORD-1', waitingMinutes: 45 })[0],
    ).toMatchObject({
      app: 'ADMIN',
      audience: { kind: 'permission', permission: 'orders.confirm' },
    });
  });

  it('a buyer rule without the order projection throws (retry → DLQ)', () => {
    const rule = RULES['order.confirmed.v1'];
    expect(() =>
      rule?.build(event('order.confirmed.v1', { orderId: 'o1', orderNo: 'ORD-1' }), null),
    ).toThrow(/order projection missing/);
  });
});
