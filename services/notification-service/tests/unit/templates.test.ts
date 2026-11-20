import { ValidationError } from '@farmx/common/errors';
import { createLogger } from '@farmx/common/logger';
import { describe, expect, it } from 'vitest';

import {
  escapeHtml,
  fill,
  formatVariables,
  placeholdersOf,
} from '../../src/features/templates/templates.renderer.js';
import { TemplatesService } from '../../src/features/templates/templates.service.js';
import type { TemplateRow, VariableDef } from '../../src/features/templates/templates.types.js';

const logger = createLogger({ service: 'test', level: 'silent', appEnv: 'local', version: '0' });

const issuesOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    return (err as ValidationError).details as { issues: { path: string; message: string }[] };
  }
  throw new Error('expected a ValidationError');
};

describe('template renderer', () => {
  const defs: VariableDef[] = [
    { name: 'orderNo', type: 'string', maxLength: 10 },
    { name: 'amount', type: 'money' },
    { name: 'payBy', type: 'date' },
    { name: 'qty', type: 'number', required: false },
  ];

  it('formats money (₹, en-IN), dates (IST) and numbers', () => {
    const v = formatVariables(defs, {
      orderNo: 'ORD-1',
      amount: '27821.5',
      payBy: '2026-11-19T06:00:00Z',
      qty: 1234567,
    });
    expect(v.amount).toBe('₹27,821.50');
    expect(v.payBy).toBe('19 Nov 2026, 11:30 am');
    expect(v.qty).toBe('12,34,567');
  });

  it('rejects unknown, missing and badly typed variables in one error', () => {
    const { issues } = issuesOf(() =>
      formatVariables(defs, { amount: 'abc', payBy: 'not a date', extra: 'x' }),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: 'extra', message: 'is not a template variable' },
        { path: 'orderNo', message: 'is required' },
        { path: 'amount', message: 'must be a valid money' },
        { path: 'payBy', message: 'must be a valid date' },
      ]),
    );
  });

  it('strips control characters, collapses whitespace and caps strings', () => {
    const v = formatVariables([{ name: 's', type: 'string', maxLength: 8 }], {
      s: 'ab\u0000\u0007c \n\t defghijk',
    });
    expect(v.s).toBe('abc def…');
  });

  it('is single-pass: a value containing {{x}} is never expanded again', () => {
    expect(fill('Hi {{a}} {{b}}', { a: '{{b}}', b: 'B' })).toBe('Hi {{b}} B');
    expect(fill('{{ missing }}!', {})).toBe('!');
    expect(placeholdersOf('{{a}} and {{ b_2 }}')).toEqual(['a', 'b_2']);
  });

  it('HTML-escapes values', () => {
    expect(fill('<b>{{x}}</b>', { x: '<script>"&\'' }, escapeHtml)).toBe(
      '<b>&lt;script&gt;&quot;&amp;&#39;</b>',
    );
  });
});

describe('TemplatesService.render', () => {
  const row = (r: Partial<TemplateRow> & Pick<TemplateRow, 'channel' | 'body'>): TemplateRow => ({
    key: 'k',
    locale: 'en',
    version: 3,
    title: null,
    htmlBody: null,
    variables: [{ name: 'orderNo', type: 'string' }],
    ...r,
  });
  const service = (rows: TemplateRow[]) => {
    let reads = 0;
    const svc = new TemplatesService({
      logger,
      templatesRepository: {
        findActive: () => {
          reads += 1;
          return Promise.resolve(rows);
        },
      } as never,
    });
    return { svc, reads: () => reads };
  };

  it('renders in-app, falls back PUSH → IN_APP, escapes email HTML, flattens SMS', async () => {
    const { svc } = service([
      row({ channel: 'IN_APP', title: 'Order {{orderNo}}', body: 'Order {{orderNo}} is ready.' }),
      row({ channel: 'EMAIL', title: 'Mail {{orderNo}}', body: 'Hello,\n\nOrder {{orderNo}}.' }),
      row({ channel: 'SMS', body: 'FarmX:\nOrder {{orderNo}}' }),
    ]);
    const r = await svc.render('k', ['PUSH', 'EMAIL', 'SMS'], { orderNo: '<O-1>' });
    expect(r).toMatchObject({ version: 3, title: 'Order <O-1>', body: 'Order <O-1> is ready.' });
    expect(r.channels).toEqual(['PUSH', 'EMAIL', 'SMS']);
    expect(r.content.PUSH).toEqual({ title: 'Order <O-1>', body: 'Order <O-1> is ready.' });
    expect(r.content.EMAIL?.subject).toBe('Mail <O-1>');
    expect(r.content.EMAIL?.html).toContain('Order &lt;O-1&gt;.');
    expect(r.content.EMAIL?.html).not.toContain('<O-1>');
    expect(r.content.SMS).toEqual({ text: 'FarmX: Order <O-1>' });
  });

  it('drops a channel without a template; caches active templates', async () => {
    const { svc, reads } = service([row({ channel: 'IN_APP', body: '{{orderNo}}' })]);
    const r = await svc.render('k', ['EMAIL', 'PUSH'], { orderNo: 'A' });
    expect(r.channels).toEqual(['PUSH']);
    await svc.render('k', [], { orderNo: 'B' });
    expect(reads()).toBe(1);
    svc.invalidate('k');
    await svc.render('k', [], { orderNo: 'C' });
    expect(reads()).toBe(2);
  });

  it('fails without an active IN_APP template', async () => {
    const { svc } = service([row({ channel: 'EMAIL', body: 'x' })]);
    await expect(svc.render('k', [], { orderNo: 'A' })).rejects.toThrow(/no active IN_APP/);
  });
});
