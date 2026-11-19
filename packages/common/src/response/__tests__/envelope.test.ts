import { ExternalServiceError, NotFoundError, ValidationError } from '../../errors/index.js';
import { describe, expect, it } from 'vitest';

import { fail, ok, paginated } from '../index.js';

describe('response envelope', () => {
  it('ok wraps data', () => {
    expect(ok({ id: 'u1' })).toEqual({ success: true, data: { id: 'u1' } });
  });

  it('paginated moves cursor info into meta', () => {
    expect(paginated({ items: [1, 2], nextCursor: 'c2', limit: 2 })).toEqual({
      success: true,
      data: [1, 2],
      meta: { nextCursor: 'c2', limit: 2 },
    });
  });

  it('fail exposes operational errors with requestId', () => {
    expect(fail(new NotFoundError('Order'), 'req-9')).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Order not found', requestId: 'req-9' },
    });
  });

  it('fail keeps validation details', () => {
    const body = fail(new ValidationError([{ path: 'email', message: 'required' }]));
    expect(body.error.details).toEqual({ issues: [{ path: 'email', message: 'required' }] });
    expect(body.error).not.toHaveProperty('requestId');
  });

  it('fail hides the message and details of non-operational errors', () => {
    const body = fail(new ExternalServiceError('razorpay', { details: { raw: 'secret' } }), 'r1');
    expect(body).toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: 'r1' },
    });
  });
});
