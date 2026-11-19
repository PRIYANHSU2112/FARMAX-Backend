import { describe, expect, it, vi } from 'vitest';

import type { Tx } from '@farmx/database';
import { AuditService } from '../../src/features/audit/audit.service.js';
import { listAuditLogsSchema } from '../../src/features/audit/audit.validation.js';

describe('AuditService', () => {
  it('passes the entry and the caller transaction to the repository', async () => {
    const auditRepository = { create: vi.fn(() => Promise.resolve({ id: 'a1' })), list: vi.fn() };
    const service = new AuditService({ auditRepository } as unknown as ConstructorParameters<
      typeof AuditService
    >[0]);
    const tx = {} as Tx;
    const entry = {
      actor: { userId: '01900000-0000-7000-8000-000000000001' },
      action: 'user.created',
      targetType: 'user' as const,
      targetId: '01900000-0000-7000-8000-000000000002',
    };
    await service.record(entry, tx);
    expect(auditRepository.create).toHaveBeenCalledWith(entry, tx);
  });
});

describe('audit validators', () => {
  const opts = { abortEarly: false, stripUnknown: true, convert: true } as const;

  it('accepts filters and converts dates', () => {
    const result = listAuditLogsSchema.querystring.validate(
      { action: 'user.status_changed', targetType: 'user', from: '2026-11-01T00:00:00Z' },
      opts,
    );
    expect(result.error).toBeUndefined();
    expect((result.value as { from: Date }).from).toBeInstanceOf(Date);
  });

  it('rejects a malformed action and to <= from', () => {
    expect(
      listAuditLogsSchema.querystring.validate({ action: 'DROP TABLE' }, opts).error,
    ).toBeDefined();
    expect(
      listAuditLogsSchema.querystring.validate(
        { from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' },
        opts,
      ).error,
    ).toBeDefined();
  });
});
