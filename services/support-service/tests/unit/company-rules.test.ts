import { describe, expect, it } from 'vitest';

import { mergeHandlers } from '../../src/adapters/events.js';
import { assertReviewable } from '../../src/features/company/company.rules.js';
import type { ApplicationStatus } from '../../src/features/company/company.types.js';
import { applyBody, reviewBody } from '../../src/features/company/company.validation.js';

const app = (status: ApplicationStatus = 'SUBMITTED') => ({ status, applicantUserId: 'u1' });

describe('application review state machine', () => {
  it('SUBMITTED → APPROVED (notes optional)', () => {
    expect(() => {
      assertReviewable(app(), 'staff', { status: 'APPROVED' });
    }).not.toThrow();
  });

  it('SUBMITTED → REJECTED with a reason', () => {
    expect(() => {
      assertReviewable(app(), 'staff', { status: 'REJECTED', reviewNotes: 'GST copy unreadable' });
    }).not.toThrow();
  });

  it.each(['APPROVED', 'REJECTED'] as const)('%s is final → 409', (status) => {
    expect(() => {
      assertReviewable(app(status), 'staff', { status: 'APPROVED' });
    }).toThrow(expect.objectContaining({ statusCode: 409 }) as Error);
  });

  it('rejection without a reason → 422', () => {
    expect(() => {
      assertReviewable(app(), 'staff', { status: 'REJECTED', reviewNotes: ' ' });
    }).toThrow(expect.objectContaining({ statusCode: 422 }) as Error);
  });

  it('nobody reviews their own application → 403', () => {
    expect(() => {
      assertReviewable(app(), 'u1', { status: 'APPROVED' });
    }).toThrow(expect.objectContaining({ statusCode: 403 }) as Error);
  });
});

describe('company validation', () => {
  it('review: notes required only when rejecting', () => {
    expect(reviewBody.validate({ status: 'APPROVED' }).error).toBeUndefined();
    expect(reviewBody.validate({ status: 'REJECTED' }).error).toBeDefined();
    expect(reviewBody.validate({ status: 'SUBMITTED' }).error).toBeDefined();
  });

  it('apply: at least one attachment receipt', () => {
    const base = { businessName: 'Sri Lakshmi Agencies', applicationType: 'DEALER' };
    expect(applyBody.validate({ ...base, attachments: [] }).error).toBeDefined();
    expect(applyBody.validate({ ...base, attachments: ['r'] }).error).toBeUndefined();
  });
});

describe('mergeHandlers', () => {
  it('runs every feature handler of the same event, in order', async () => {
    const calls: string[] = [];
    const merged = mergeHandlers(
      {
        'user.deleted.v1': () => {
          calls.push('tickets');
          return Promise.resolve();
        },
      },
      {
        'user.deleted.v1': () => {
          calls.push('company');
          return Promise.resolve();
        },
      },
    );
    await merged['user.deleted.v1']?.({} as never, {} as never);
    expect(calls).toEqual(['tickets', 'company']);
  });
});
