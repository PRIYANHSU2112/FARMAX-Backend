import type { EventEnvelope } from '@farmx/infra/events';
import { describe, expect, it } from 'vitest';

import { EVENT_BINDINGS, RULES } from '../../src/features/events/events.rules.js';
import { fromColumns, toColumns } from '../../src/features/audience/index.js';

const env = (type: string, data: object): EventEnvelope => ({
  id: '01900000-0000-7000-8000-00000000e001',
  type,
  version: 1,
  occurredAt: '2026-11-20T00:00:00.000Z',
  source: 'farm-service',
  correlationId: 'c',
  data,
});

const base = {
  contentId: '01900000-0000-7000-8000-0000000000c1',
  contentVersion: 2,
  kind: 'ALERT',
  severity: 'WARNING',
  title: 'ND near Tanuku',
  placeLabel: 'Tanuku',
};

const build = (type: string, data: object) => {
  const rule = RULES[type];
  if (rule === undefined) throw new Error(`no rule ${type}`);
  return rule.build(env(type, data), null);
};

describe('content event rules', () => {
  it('binds the three content events', () => {
    expect(EVENT_BINDINGS).toEqual(
      expect.arrayContaining([
        'content.published.v1',
        'content.corrected.v1',
        'content.retracted.v1',
      ]),
    );
  });

  it('published: segment audience, business dedupe key, deep link without personal data', () => {
    const [d] = build('content.published.v1', { ...base, summary: 'Confirmed in 3 flocks.' });
    expect(d).toMatchObject({
      dedupeKey: `content.published:${base.contentId}:v2`,
      category: 'CONTENT',
      priority: 'HIGH',
      app: 'CUSTOMER',
      audience: { kind: 'farmContent', contentId: base.contentId, scope: 'segment' },
      channels: ['PUSH'],
      templateKey: 'content.alert',
      data: { entityType: 'content', entityId: base.contentId, contentVersion: 2 },
    });
    expect(JSON.stringify(d)).not.toMatch(/"(lat|lng|latitude|longitude|areaLat|areaLng)"/);
  });

  it('priority: CRITICAL alert mandatory, news NORMAL (capped), retraction HIGH', () => {
    const [critical] = build('content.published.v1', {
      ...base,
      severity: 'CRITICAL',
      summary: 's',
    });
    const [news] = build('content.published.v1', {
      ...base,
      kind: 'NEWS',
      severity: null,
      summary: 's',
    });
    const [retracted] = build('content.retracted.v1', {
      ...base,
      kind: 'NEWS',
      severity: null,
      retractNote: 'Wrong data',
      wasNotified: false,
    });
    expect(critical?.priority).toBe('CRITICAL');
    expect(news).toMatchObject({ priority: 'NORMAL', templateKey: 'content.news' });
    expect(retracted).toMatchObject({
      priority: 'HIGH',
      audience: { kind: 'farmContent', contentId: base.contentId, scope: 'savers' },
    });
  });

  it('retraction after a push reaches the segment too; corrections reach segment + savers', () => {
    const [r] = build('content.retracted.v1', { ...base, retractNote: 'x', wasNotified: true });
    const [c] = build('content.corrected.v1', { ...base, correctionNote: 'Fixed mandals' });
    expect(r?.audience).toMatchObject({ scope: 'both' });
    expect(c).toMatchObject({
      dedupeKey: `content.corrected:${base.contentId}:v2`,
      audience: { scope: 'both' },
      templateKey: 'content.corrected',
      vars: { title: base.title, note: 'Fixed mandals' },
    });
  });

  it('FARM_CONTENT audience round-trips through the stored columns', () => {
    const spec = { kind: 'farmContent', contentId: base.contentId, scope: 'both' } as const;
    const cols = toColumns(spec);
    expect(cols).toEqual({
      audienceType: 'FARM_CONTENT',
      audience: { contentId: base.contentId, scope: 'both' },
    });
    expect(fromColumns(cols.audienceType, cols.audience)).toEqual(spec);
  });
});
